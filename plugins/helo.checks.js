// Check various bits of the HELO string
var dns       = require('dns');
var net_utils = require('./net_utils');

var checks = [
    'init',               // config loading, multiplicity detection
    'match_re',           // List of regexps
    'bare_ip',            // HELO is bare IP (vs required Address Literal)
    'dynamic',            // HELO hostname looks dynamic (dsl|dialup|etc...)
    'big_company',        // Well known HELOs that must match rdns
    'literal_mismatch',   // IP literal that doesn't match remote IP
    'valid_hostname',     // HELO hostname is a legal DNS name
    'rdns_match',         // HELO hostname matches rDNS
    'forward_dns',        // HELO hostname resolves to the connecting IP
    'mismatch',           // hostname differs between invocations
    'emit_log',           // emit a loginfo summary
];

exports.register = function () {
    var plugin = this;

    for (var i=0; i < checks.length; i++) {
        var hook = checks[i];
        plugin.register_hook('helo', hook);
        plugin.register_hook('ehlo', hook);
    }
};

exports.hook_connect = function (next, connection) {
    var plugin = this;
    plugin.cfg = plugin.config.get('helo.checks.ini', {
        booleans: [
            '+check.match_re',
            '+check.bare_ip',
            '+check.dynamic',
            '+check.big_company',
            '+check.valid_hostname',
            '+check.forward_dns',
            '+check.rdns_match',
            '+check.mismatch',

            '+reject.valid_hostname',
            '+reject.match_re',
            '+reject.bare_ip',
            '+reject.dynamic',
            '+reject.big_company',
            '-reject.forward_dns',
            '-reject.literal_mismatch',
            '-reject.rdns_match',
            '-reject.mismatch',

            '+skip.private_ip',
            '+skip.whitelist',
            '+skip.relaying',
        ],
    });

    // backwards compatible with old config file
    if (plugin.cfg.check_no_dot !== undefined) {
        plugin.cfg.check.valid_hostname = plugin.cfg.check_no_dot ? true : false;
    }
    if (plugin.cfg.check_dynamic !== undefined) {
        plugin.cfg.check.dynamic = plugin.cfg.check_dynamic ? true : false;
    }
    if (plugin.cfg.check_raw_ip !== undefined) {
        plugin.cfg.check.bare_ip = plugin.cfg.check_raw_ip ? true : false;
    }

    return next();
};

exports.init = function (next, connection, helo) {
    var plugin = this;

    var hc = connection.results.get('helo.checks');
    if (!hc) {     // first HELO result
        connection.results.add(plugin, {helo_host: helo});
        return next();
    }

    // we've been here before
    connection.results.add(plugin, {multi: true});

    return next();
};

exports.should_skip = function (connection, test_name) {
    var plugin = this;

    var hc = connection.results.get('helo.checks');
    if (hc && hc.multi && test_name !== 'mismatch') return true;

    if (!plugin.cfg.check[test_name]) {
        connection.results.add(plugin, {skip: test_name + '(config)'});
        return true;
    }

    if (plugin.cfg.skip.relaying && connection.relaying) {
        connection.results.add(plugin, {skip: test_name + '(relay)'});
        return true;
    }

    if (plugin.cfg.skip.private_ip && net_utils.is_rfc1918(connection.remote_ip)) {
        connection.results.add(plugin, {skip: test_name + '(private)'});
        return true;
    }

    return false;
};

exports.is_ipv4_literal = function (host) {
    return /^\[(\d{1,3}\.){3}\d{1,3}\]$/.test(host) ? true : false;
};

exports.mismatch = function (next, connection, helo) {
    var plugin = this;

    if (plugin.should_skip(connection, 'mismatch')) return next();

    var prev_helo = connection.results.get('helo.checks').helo_host;
    if (!prev_helo) {
        connection.results.add(plugin, {skip: 'mismatch(1st)'});
        return next();
    }

    if (prev_helo === helo) {
        connection.results.add(plugin, {pass: 'mismatch'});
        return next();
    }

    var msg = 'mismatch(' + prev_helo + ' / ' + helo + ')';
    connection.results.add(plugin, {fail: msg});
    if (plugin.cfg.reject.mismatch) return next(DENY, 'HELO host ' + msg);

    return next();
};

exports.valid_hostname = function (next, connection, helo) {
    var plugin = this;

    if (plugin.should_skip(connection, 'valid_hostname')) return next();

    if (plugin.is_ipv4_literal(helo)) {
        connection.results.add(plugin, {skip: 'valid_hostname(literal)'});
        return next();
    }

    if (!/\./.test(helo)) {
        connection.results.add(plugin, {fail: 'valid_hostname(no_dot)'});
        if (plugin.cfg.reject.valid_hostname) {
            return next(DENY, 'Host names have more than one DNS label');
        }
        return next();
    }

    // this will fail if TLD is invalid or hostname is a public suffix
    if (!net_utils.get_organizational_domain(helo)) {
        connection.results.add(plugin, {fail: 'valid_hostname'});
        if (plugin.cfg.reject.valid_hostname) {
            return next(DENY, "HELO host name invalid");
        }
        return next();
    }

    connection.results.add(plugin, {pass: 'valid_hostname'});
    return next();
};

exports.match_re = function (next, connection, helo) {
    var plugin = this;

    if (plugin.should_skip(connection, 'match_re')) return next();

    var regexps = plugin.config.get('helo.checks.regexps', 'list');

    var fail=0;
    for (var i=0; i < regexps.length; i++) {
        var re = new RegExp('^' + regexps[i] + '$');
        if (re.test(helo)) {
            connection.results.add(plugin, {fail: 'match_re(' + regexps[i] + ')'});
            fail++;
        }
    }
    if (fail && plugin.cfg.reject.match_re) return next(DENY, "BAD HELO");
    if (!fail) connection.results.add(plugin, {pass: 'match_re'});
    return next();
};

exports.rdns_match = function (next, connection, helo) {
    var plugin = this;

    if (plugin.should_skip(connection, 'rdns_match')) return next();

    if (!helo) {
        connection.results.add(plugin, {fail: 'rdns_match(empty)'});
        return next();
    }

    if (plugin.is_ipv4_literal(helo)) {
        connection.results.add(plugin, {fail: 'rdns_match(literal)'});
        return next();
    }

    var r_host = connection.remote_host;
    if (r_host && helo === r_host) {
        connection.results.add(plugin, {pass: 'rdns_match'});
        return next();
    }

    if (net_utils.get_organizational_domain(r_host) ===
        net_utils.get_organizational_domain(helo)) {
        connection.results.add(plugin, {pass: 'rdns_match(org_dom)'});
        return next();
    }

    connection.results.add(plugin, {fail: 'rdns_match'});
    if (plugin.cfg.reject.rdns_match) {
        return next(DENY, 'HELO host does not match rDNS');
    }
    return next();
};

exports.bare_ip = function (next, connection, helo) {
    var plugin = this;

    if (plugin.should_skip(connection, 'bare_ip')) return next();

    // RFC 2821, 4.1.1.1  Address literals must be in brackets
    // RAW IPs must be formatted: "[1.2.3.4]" not "1.2.3.4" in HELO
    if(/^\d+\.\d+\.\d+\.\d+$/.test(helo)) {
        connection.results.add(plugin, {fail: 'bare_ip(invalid literal)'});
        if (plugin.cfg.reject.bare_ip) return next(DENY, "Invalid address format in HELO");
        return next();
    }

    connection.results.add(plugin, {pass: 'bare_ip'});
    return next();
};

exports.dynamic = function (next, connection, helo) {
    var plugin = this;

    if (plugin.should_skip(connection, 'dynamic')) return next();

    // Skip if no dots or an IP literal or address
    if (!/\./.test(helo)) {
        connection.results.add(plugin, {skip: 'dynamic(no dots)'});
        return next();
    }

    if (/^\[?\d+\.\d+\.\d+\.\d+\]?$/.test(helo)) {
        connection.results.add(plugin, {skip: 'dynamic(literal)'});
        return next();
    }

    if (net_utils.is_ip_in_str(connection.remote_ip, helo)) {
        connection.results.add(plugin, {fail: 'dynamic'});
        if (plugin.cfg.reject.dynamic) return next(DENY, 'HELO is dynamic');
        return next();
    }

    connection.results.add(plugin, {pass: 'dynamic'});
    return next();
};

exports.big_company = function (next, connection, helo) {
    var plugin = this;

    if (plugin.should_skip(connection, 'big_company')) return next();

    if (plugin.is_ipv4_literal(helo)) {
        connection.results.add(plugin, {skip: 'big_co(literal)'});
        return next();
    }

    if (!plugin.cfg.bigco) {
        connection.results.add(plugin, {err: 'big_co(config missing)'});
        return next();
    }

    if (!plugin.cfg.bigco[helo]) {
        connection.results.add(plugin, {pass: 'big_co(not)'});
        return next();
    }

    var rdns = connection.remote_host;
    if (!rdns || rdns === 'Unknown' || rdns === 'DNSERROR') {
        connection.results.add(plugin, {fail: 'big_co(rDNS)'});
        if (plugin.cfg.reject.big_company) {
            return next(DENY, "Big company w/o rDNS? Unlikely.");
        }
        return next();
    }

    var allowed_rdns = plugin.cfg.bigco[helo].split(/,/);
    for (var i=0; i < allowed_rdns.length; i++) {
        var re = new RegExp(allowed_rdns[i].replace(/\./g, '\\.') + '$');
        if (re.test(rdns)) {
            connection.results.add(plugin, {pass: 'big_co'});
            return next();
        }
    }

    connection.results.add(plugin, {fail: 'big_co'});
    if (plugin.cfg.reject.big_company) {
        return next(DENY, "You are not who you say you are");
    }
    return next();
};

exports.literal_mismatch = function (next, connection, helo) {
    var plugin = this;

    if (plugin.should_skip(connection, 'literal_mismatch')) return next();

    var literal = /^\[(\d+\.\d+\.\d+\.\d+)\]$/.exec(helo);
    if (!literal) {
        connection.results.add(plugin, {pass: 'literal_mismatch'});
        return next();
    }

    var lmm_mode = parseInt(plugin.cfg.check.literal_mismatch);
    var helo_ip = literal[1];
    if (lmm_mode > 2 && net_utils.is_rfc1918(helo_ip)) {
        connection.results.add(plugin, {pass: 'literal_mismatch(private)'});
        return next();
    }

    if (lmm_mode > 1) {
        if (net_utils.same_ipv4_network(connection.remote_ip, [helo_ip])) {
            connection.results.add(plugin, {pass: 'literal_mismatch'});
            return next();
        }

        connection.results.add(plugin, {fail: 'literal_mismatch'});
        if (plugin.cfg.reject.literal_mismatch) {
            return next(DENY, 'HELO IP literal not in the same /24 as your IP address');
        }
        return next();
    }

    if (helo_ip === connection.remote_ip) {
        connection.results.add(plugin, {pass: 'literal_mismatch'});
        return next();
    }

    connection.results.add(plugin, {fail: 'literal_mismatch'});
    if (plugin.cfg.reject.literal_mismatch) {
        return next(DENY, 'HELO IP literal does not match your IP address');
    }
    return next();
};

exports.forward_dns = function (next, connection, helo) {
    var plugin = this;

    if (plugin.should_skip(connection, 'forward_dns')) return next();
    if (!plugin.cfg.check.valid_hostname) {
        connection.results.add(plugin, {err: 'forward_dns(valid_hostname disabled)'});
        return next();
    }

    if (!connection.results.has('helo.checks', 'pass', /^valid_hostname/)) {
        connection.results.add(plugin, {fail: 'forward_dns(invalid_hostname)'});
        return next();
    }

    if (plugin.is_ipv4_literal(helo)) {
        connection.results.add(plugin, {skip: 'forward_dns(literal)'});
        return next();
    }

    var cb = function (err, ips) {
        if (err) {
            if (err.code === 'ENOTFOUND' || err.code === 'ENODATA') {
                connection.results.add(plugin, {fail: 'forward_dns('+err.code+')'});
                return next();
            }
            connection.results.add(plugin, {err: 'forward_dns('+err+')'});
            return next();
        }

        if (!ips) {
            connection.results.add(plugin, {err: 'forward_dns, no ips!'});
            return next();
        }
        connection.results.add(plugin, {ips: ips});

        if (ips.indexOf(connection.remote_ip) !== -1) {
            connection.results.add(plugin, {pass: 'forward_dns'});
            return next();
        }

        // some valid hosts (facebook.com, hotmail.com, ) use a generic HELO
        // hostname that resolves but doesn't contain the IP that is
        // connecting. If their rDNS passed, and their HELO hostname is in
        // the same domain, consider it close enough.
        if (connection.results.has('helo.checks', 'pass', /^rdns_match/)) {
            var helo_od = net_utils.get_organizational_domain(helo);
            var rdns_od = net_utils.get_organizational_domain(connection.remote_host);
            if (helo_od && helo_od === rdns_od) {
                connection.results.add(plugin, {pass: 'forward_dns(domain)'});
                return next();
            }
            connection.results.add(plugin, {msg: "od miss: " + helo_od + ', ' + rdns_od});
        }

        connection.results.add(plugin, {fail: 'forward_dns(no IP match)'});
        if (plugin.cfg.reject.forward_dns) {
            return next(DENY, "HELO host has no forward DNS match");
        }
        return next();
    };

    plugin.get_a_records(helo, cb);
};

exports.emit_log = function (next, connection, helo) {
    var plugin = this;
    // Spits out an INFO log entry. Default looks like this:
    // [helo.checks] helo_host: [182.212.17.35], fail:big_co(rDNS) rdns_match(literal), pass:valid_hostname, match_re, bare_ip, literal_mismatch, mismatch, skip:dynamic(literal), valid_hostname(literal)
    //
    // Although sometimes useful, that's a bit verbose. I find that I'm rarely
    // interested in the passes, the helo_host is already logged elsewhere,
    // and so I set this in config/results.ini:
    //
    // [helo.checks]
    // order=fail,pass,msg,err,skip
    // hide=helo_host,multi,pass
    //
    // Thus set, my log entries look like this:
    //
    // [UUID] [helo.checks] fail:rdns_match
    // [UUID] [helo.checks]
    // [UUID] [helo.checks] fail:dynamic
    connection.loginfo(plugin, connection.results.collate(plugin));
    return next();
};

exports.get_a_records = function (host, cb) {
    var plugin = this;

    if (!/\./.test(host)) {
        // a single label is not a host name
        var e = new Error("invalid hostname");
        e.code = 'ENOTFOUND';
        return cb(e);
    }

    // Set-up timer
    var timer = setTimeout(function () {
        plugin.logerror('timeout!');
        return cb(new Error('timeout'));
    }, (plugin.cfg.main.dns_timeout || 5) * 1000);

    // fully qualify, to ignore any search options in /etc/resolv.conf
    if (!/\.$/.test(host)) { host = host + '.'; }

    // do the queries
    dns.resolve(host, function(err, ips) {
        if (timer) clearTimeout(timer);
        if (err) return cb(err, ips);
        // plugin.logdebug(plugin, host + ' => ' + ips);
        // return the DNS results
        return cb(null, ips);
    });
};

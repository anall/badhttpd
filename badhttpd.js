#!/usr/bin/env node
var util        = require('util'),
    net         = require('net'),
    byline      = require('byline'),
    sets        = require('simplesets'),
    dict        = require('dict'),
    optimist    = require('optimist');
var argv= optimist
    // Host
    .default('host','127.0.0.1')
    .alias('host','h')
    .describe('host',"Host to bind to")

    // Port
    .default('port',8051)
    .alias('port','p')
    .describe('port',"Port to bind to")

    // Should we actually read data from the client
    .boolean('read')
    .default('read',true)
    .describe('read',"Actually read data from the client")

    // Timeout
    .default('timeout',0)
    .alias('timeout','t')
    .describe('timeout',"How long to hang, in seconds, 0 means forever")

    // Disconnect
    .boolean('disconnect')
    .default('disconnect',false)
    .describe('disconnect',"Disconnect instead of hanging")
    
    // Misc stuff
    .boolean('help')
    // We're done
    .argv;

// If we want help, just give the help and be done
if ( argv.help ) {
    optimist.showHelp()
    return;
}

var clients = new sets.Set();

// Timeout stuff

function runTimeout() {
    var work = clients.array();
    var timeout = argv.timeout * 1000;
    var now = new Date().getTime();
    work.forEach( function(client, idx, a) {
        if ( now - client._localData.lastTime > timeout ) {
            client.end();
        }
    });
}

if ( argv.timeout > 0 ) {
    setInterval(runTimeout,1000)
}

// Client state machine
var ST_INVALID = -2;
var ST_HANG = -1;
var ST_PRE = 0;
var ST_READ_HEADER = 1;
var ST_DONE_HEADER = 2;

var RX_METHOD_LINE = /^(GET|POST) (\/[^ ]*) (HTTP\/[0-9\.]+)$/;
var RX_HEADER = /^([A-Za-z0-9-]+): (.+)$/;
var RX_SPLIT_URI = /^\/([a-zA-Z0-9]+):([^\/]*)(\/.*)?$/;

function parseUri(uri) {
    var rv = dict({});
    var part;
    var rest = uri;
    while ( rest && ( part = rest.match( RX_SPLIT_URI ) ) ) {
        var key = part[1];
        var value = part[2];
        rest = part[3];

        if ( rv.has(key) ) {
            throw "repeated key " + key;
        } else if ( key == 'redir' ) {
            var nValue = Number(value);
            if ( value == "true" ) {
                nValue = 1;
            } else if ( value == "false" ) {
                nValue = 0;
            } else if ( value == "loop" ) {
                nValue = -1;
            } else if ( isNaN(nValue) ) {
                throw "invalid value for 'redir': " + value;
            }
            if ( nValue )
                rv.set('redir',nValue);
        } else if ( key == 'next' ) {
            rv.set('next',rest);
            rest = undefined;
        } else {
            throw "invalid key " + key;
        }
    }
    return rv;
}

function deparseUri(data) {
    var next = data.get('next');
    var rv = "";
    data.forEach( function(v,k) {
        rv = rv + "/" + k + ":" + v;
    } );
    if ( next )
        rv = rv + "/next:" + next;
    return rv;
}

function respondError(c,error) {
    c.write("HTTP/1.1 500 Infernal Server Error\r\n");
    c.write("\r\n" + error + "\r\n");
    c.end();
}

function respondRedirect(c,dest) {
    var localData = c._localData;
    var host = localData.headers['Host']
    if ( !host ) {
        host = argv.host + ":" + argv.port;
    }
    if ( ! dest ) {
        return respondError( c, "Invalid destination" );
    }

    c.write("HTTP/1.1 302 Found\r\n");
    c.write( "Location: http://" + host + dest + "\r\n");
    c.write("\r\nYou can has redirect\r\n");
    c.end();
}

function doRespond(c) {
    var localData = c._localData;
    var uriData = localData.uriData;

    localData.lastTime = new Date().getTime();

    if ( localData.returnError ) {
        return respondError( c, localData.returnError );
    } else if ( uriData.has('next') ) {
        // Next overrides redir as a redirect, redir is for redirect loop
        return respondRedirect( c, uriData.get('next') );
    } else if ( uriData.has('redir') ) {
        var redir = uriData.get('redir');
        if ( redir < 0 ) { // negative numbers are infinite
        } else if ( redir-1 <= 0 ) {
            uriData.delete('redir');
        } else {
            uriData.set('redir', redir-1);
        }
        return respondRedirect( c, deparseUri( uriData ) );
    }
}

function gotLine(c,line,stream) {
    var localData = c._localData;

    localData.lastTime = new Date().getTime();
    var state = localData.state;
    if ( state == ST_PRE ) {
        var data = line.match(RX_METHOD_LINE);
        if ( data ) {
            console.log( line );
            localData.method = data[1];
            localData.uri = data[2];
            localData.headers = {};
            state = ST_READ_HEADER;
            try {
                localData.uriData = parseUri( localData.uri );
                if ( localData.uriData.has('disconnect') ) {
                    localData.disconnect = !! localData.uriData.get('disconnect');
                }
            } catch (e) {
                localData.returnError = e;
                console.log("URI Parse error: " + e);
                localData.disconnect = false;
            }
        } else {
            state = ST_INVALID;
        }
    } else if ( state == ST_READ_HEADER ) {
        if ( line == "" ) {
            state = ST_DONE_HEADER;
            doRespond(c);
        } else {
            var data = line.match(RX_HEADER);
            localData.headers[ data[1] ] = data[2];
        }
    } else if ( state == ST_DONE_HEADER ) {
        state = ST_INVALID;
    }

    if ( state == ST_HANG ) {
        if ( localData.disconnect ) {
            c.end();
        } else {
            c.pause();
        }
    } else if ( state == ST_INVALID ) {
        console.log("Reached invalid state");
        c.end();
    }

    localData.state = state;
}

function _dumpDict( dict ) {
    var rv = {};
    if ( dict )
        dict.forEach( function(v,k) { rv[k] = v; } );
    return rv;
}

function onServerConnect(c) {
    clients.add( c );
    c._localData = {
        "lastTime": new Date().getTime(),
        "state": ST_PRE,
        "disconnect": argv.disconnect
    };
    c.setEncoding('utf8');
    c.setKeepAlive(false);

    c.on('end', function() {
        clients.remove( c );
    });

    // If we don't want to read anything, never even start
    if ( argv.read ) {
        lineStream = byline.createStream( c, {"keepEmptyLines": true} );
        lineStream.on('data',function(line) { gotLine(c,line,this); });
    } else if ( c._localData.disconnect ) {
        c.end();
    } else {
        c.pause();
    }
}

var server = net.createServer( onServerConnect );
server.listen( argv.port, argv.host, function() {
    console.log("Server listening")
});

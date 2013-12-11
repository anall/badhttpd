#!/usr/bin/env node
/*
Copyright (c) 2013, Andrea Nall

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

var util        = require('util'),
    net         = require('net'),
    byline      = require('byline'),
    Set         = require('set'),
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

var clients = new Set();

// Timeout stuff
var timeout = argv.timeout * 1000;

function runTimeout() {
    var work = clients.array();
    var now = new Date().getTime();
    work.forEach( function(client, idx, a) {
        if ( now - client._localData.lastTime > client._localData.timeout ) {
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
var ST_RESPOND = 2;

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
            if ( nValue ) {
                rv.set('redir',nValue);
                rv.set('_orig_redir',value);
            }
        } else if ( key == 'next' ) {
            rv.set('next',rest);
            rest = undefined;
        } else if ( key == 'disconnect' ) {
            rv.set('disconnect', !!value);
        } else if ( key == 'hangon' ) {
            var nValue;
            if ( value == "read_header" )
                nValue = ST_READ_HEADER;
            else if ( value == "respond" )
                nValue = ST_RESPOND;
            
            if (typeof nValue === 'undefined') {
                throw "invalid value for 'hangon': " + value;
            } else {
                rv.set('hangon',nValue);
                rv.set('_orig_hangon',value);
            }
        } else if ( key == "timeout" ) {
            var nValue = Number(value);
            if ( isNaN(nValue) ) {
                throw "invalid value for 'timeout': " + value;
            }
            rv.set('timeout',nValue);
        } else if ( key == "delay" ) {
            var nValue = Number(value);
            if ( isNaN(nValue) ) {
                throw "invalid value for 'delay': " + value;
            }
            rv.set('delay',nValue);
        } else {
            throw "invalid key " + key;
        }
    }
    return rv;
}

function deparseUri(data) {
    // Rework some things
    ['redir','hangon'].forEach( function(key,idx,a) {
        if ( data.has('_orig_' + key) )
            data.set(key, data.get('_orig_' + key) );
    } );

    var next = data.get('next');
    var rv = "";
    data.forEach( function(v,k) {
        if ( k.match(/^_/) ) return; // Skip internal ones
        if ( k == 'next' ) return; // Skip next

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
    } else if ( uriData.has('redir') ) {
        var redir = uriData.get('redir');
        if ( redir < 0 ) { // negative numbers are infinite
            if ( uriData.has('next') )
                return respondError( c, "infinite redirect and 'next' do not mix" );
        } else if ( redir-1 <= 0 ) {
            uriData.delete('redir');
            uriData.delete('_orig_redir');
        } else {
            uriData.set('redir', redir-1);
            uriData.delete('_orig_redir');
        }
        return respondRedirect( c, deparseUri( uriData ) );
    } else if ( uriData.has('next') ) { // Redir should take priority
        return respondRedirect( c, uriData.get('next') );
    }
}

function gotLine(c,line,stream) {
    var localData = c._localData;

    localData.lastTime = new Date().getTime();
    localData.timeout = timeout;
    localData.hangState = undefined;

    var state = localData.state;
    if ( localData.hangState == state )
        state = ST_HANG;

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
                if ( localData.uriData.has('disconnect') )
                    localData.disconnect = !! localData.uriData.get('disconnect');
                if ( localData.uriData.has('timeout') )
                    localData.timeout = localData.uriData.get('timeout');
                if ( localData.uriData.has('hangon') )
                    localData.hangState = localData.uriData.get('hangon');
                if ( localData.uriData.has('delay') )
                    if ( localData.uriData.get('delay') > localData.timeout )
                        throw "Delay longer than timeout";
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
            state = ST_RESPOND;
            if ( localData.uriData.has('delay') ) {
                setTimeout( function() { doRespond(c); }, localData.uriData.get('delay') * 1000 );
            } else {
                doRespond(c);
            }
        } else {
            var data = line.match(RX_HEADER);
            localData.headers[ data[1] ] = data[2];
        }
    } else if ( state == ST_RESPOND ) {
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

    c.on('error', function(e) {}); // We honestly do not care here.
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

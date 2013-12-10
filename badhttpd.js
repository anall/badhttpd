#!/usr/bin/env node
var util        = require('util'),
    net         = require('net'),
    byline      = require('byline'),
    sets        = require('simplesets'),
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
    console.log("timeout = ", argv.timeout)
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

function gotLine(c,line,stream) {
    var localData = c._localData;

    localData.lastTime = new Date().getTime();
    var state = localData.state;
    console.log(line);
    if ( state == ST_PRE ) {
        var data = line.match(RX_METHOD_LINE);
        if ( data ) {
            localData.method = data[1];
            localData.uri = data[2];
            localData.headers = {};
            console.log(c._localData);
            state = ST_READ_HEADER;
        } else {
            state = ST_INVALID;
        }
    } else if ( state == ST_READ_HEADER ) {
        if ( line == "" ) {
            state = ST_DONE_HEADER;
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

function onServerConnect(c) {
    clients.add( c );
    c._localData = {
        "lastTime": new Date().getTime(),
        "state": ST_PRE,
        "disconnect": argv.disconnect
    };
    c.setEncoding('utf8');

    console.log('client connected :', clients.size());
    c.on('end', function() {
        clients.remove( c );
        console.log('client disconnected: ', clients.size());
        console.log( c._localData );
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

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
var ST_PRE = 0;

function gotLine(c,line) {
    c._localData.lastTime = new Date().getTime();
    var state = c._localData.state;
    console.log(line);
    c._localData.state = state;
}

function onServerConnect(c) {
    clients.add( c );
    c._localData = {
        "lastTime": new Date().getTime(),
        "state": ST_PRE
    };
    c.setEncoding('utf8');

    console.log('client connected :', clients.size());
    c.on('end', function() {
        clients.remove( c );
        console.log('client disconnected: ', clients.size());
    });

    // If we don't want to read anything, never even start
    if ( argv.read ) {
        lineStream = byline.createStream( c, {"keepEmptyLines": true} );
        lineStream.on('data',function(line) { gotLine(c,line); });
    }
}

var server = net.createServer( onServerConnect );
server.listen( argv.port, argv.host, function() {
    console.log("Server listening")
});

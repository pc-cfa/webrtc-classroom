/*
 * (C) Copyright 2014-2015 Kurento (http://kurento.org/)
 * (C) Copyright 2016-2016 Luddite (http://ludditeenterprises.com/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

var express  = require('express');
var minimist = require('minimist');
var https    = require('https');
var path     = require('path');
var url      = require('url');
var ws       = require('ws');
var fs       = require('fs');

var kurento  = require('kurento-client');
var mkdirp   = require('mkdirp');

var config   = require("./config.json");

var mongodb  = require("mongodb");

var MongoClient = mongodb.MongoClient;
var db;

var app = express();

///////////////////////////////////////////////////////////////////////////////
// command line arguments
var argv = minimist(process.argv.slice(2), {
  default: {
    as_uri: 'https://localhost:8443/',
    ws_uri: 'ws://localhost:8888/kurento'
  }
});

///////////////////////////////////////////////////////////////////////////////
// https wss keys
var options = {
  key:  fs.readFileSync('keys/server.key'),
  cert: fs.readFileSync('keys/server.crt')
};

///////////////////////////////////////////////////////////////////////////////
//  Definition of global variables.  
var webinarOwners          = {}; // userId of webinar HOST by webinarId
var webinarStartTimes      = {}; // new Date() taken when HOST first connected, by webinarId
var webinarIdByPresenterId = {}; // webinarId by presenterId
var webinarRecordingIds    = {}; // webinar recordingId by webinarId

var webinarLastFile        = {}; // webinarLastFile[webinarId]++; Only used in create folders for file naming...

// interface to the kurento-media-server via JSON message passing over a websocket 
var kurentoClient       = null;
var iceCandidatesQueues = {};

var bLogIceCandidateMessages = false;

// array of client sessions addressed by sessionId
var sessionId = -1;
var sessions  = [];

var noPresenterMessage = 'Could not find requested presenter...';

var startingDirectories = ['/tmp', '/home/peter/Videos'];
var fileExtensions      = ['.webm', '.mp4', '.mp3', '.mov', '.avi', '.mkv'];
var fileInfoArray       = [];

var heartbeatTimerId    = null;
var heartbeatId         = 0;
var heartbeatFunctions  = [];

///////////////////////////////////////////////////////////////////////////////
//  Server and SocketServer startup
///////////////////////////////////////////////////////////////////////////////
var asUrl = url.parse(argv.as_uri);
var port  = asUrl.port;

var server = https.createServer(options, app).listen(port, function() {
  console.log('Open ' + url.format(asUrl) + ' with a WebRTC capable browser');

  scanFileInfoArray();

  startHeartbeatTimer();
});

app.use(express.static(path.join(__dirname, 'static')));

///////////////////////////////////////////////////////////////////////////////
app.get('/video/:filename', function (req, res, next) {
 
  console.log("got a request for video file ", req.url);

//if (req.url === '/movie.mp4') {
  if (true) {
////var file      = path.resolve(__dirname,'Videos/Silicon.Valley/Silicon.Valley.S03E01.HDTV.x264-KILLERS[eztv].mkv');
 //   var file      = '/home/peter/Videos/Silicon.Valley/Silicon.Valley.S03E01.HDTV.x264-KILLERS[eztv].mkv';
  //var file      = '/home/peter/Videos/Silicon.Valley/SV.S03E02.mp4';
    var file      = '/home/peter/Videos/Presentation_peter_screen_20160801_231157.webm';
//  var file      = '/home/peter/Videos/small.mov';
  //var file      = '/home/peter/Videos/Presentation_pedro_webcam_20160802_000024.webm';




    fs.stat(file, (err, stats) => {
      if (err) {
        if (err.code === 'ENOENT') { return res.sendStatus(404); } // 404 file not found
        
        return res.end(err);
      }

      var range     = req.headers.range;

      if (!range) { return res.sendStatus(416); } // 416 Wrong range
      
      var positions = range.replace(/bytes=/, '').split('-');
      var start     = parseInt(positions[0], 10);

      var total     = stats.size;
      var end       = positions[1] ? parseInt(positions[1], 10) : total - 1;
      var chunkSize = (end - start) + 1;

      res.writeHead(206, {
        'Content-Range' : 'bytes ' + start + '-' + end + '/' + total,
        'Accept-Ranges' : 'bytes',
        'Content-Length': chunkSize,
        'Content-Type'  : 'video/webm'
      //'Content-Type'  : 'video/mkv'
      //'Content-Type'  : 'video/mp4'
      });

      var stream = fs.createReadStream(file, { start: start, end: end })
        .on('open', () => { stream.pipe(res); })
        .on('error', (err) => { res.end(err); });

      res.on('close', () => {
        // close or destroy stream
        stream = null; 
      });

    }); //fs.stat(file, (err, stats)
  } // if (req.url === '/movie.mp4')

});

///////////////////////////////////////////////////////////////////////////////
function processFileUpload(message) {

  var date      = new Date();
  var timeRegex = /^.*T(\d{2}):(\d{2}):(\d{2}).*$/
  var dateRegex = /^(\d{4})-(\d{2})-(\d{2})T.*$/
  var dateData  = dateRegex.exec(date.toJSON());
  var timeData  = timeRegex.exec(date.toJSON());
  var today     = dateData[1] + dateData[2] + dateData[3];
  var now       = timeData[1] + timeData[2] + timeData[3];

  var filepath = '/home/peter/Pictures/' + 'snapshot' + '_' + today + '_' + now + '.' + 'png'; 

  fs.writeFile(filepath, message.file_data, 'base64', function(error) {
    if (error) { 
      console.log(error); 
      // TODO advise of failure
      return;
    }

    if (message.thumbnail_data != null) {
      var thumbnailpath = '/home/peter/Pictures/' + 'snapshot' + '_' + today + '_' + now + '_thumbnail' + '.' + 'png'; 

      fs.writeFile(thumbnailpath, message.thumbnail_data, 'base64', function(err) {
        if (error) { 
          console.log(error);
          // TODO cleanup
          // TODO advise of failure
          return;
        }

        // TODO advise availability of thumbnail file
        // TODO advise availability of main file
      });      
    }
    else {
      // TODO advise availability of main file only
    }
  });  
}

///////////////////////////////////////////////////////////////////////////////
var web_socket_server = new ws.Server({
  server: server,
  path: '/classroom'
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
// heartbeat timer helper functions
function startHeartbeatTimer() {
  
  heartbeatTimerId = setInterval(function() { 
    //console.log("Heartbeat timer event");

    for (var i = 0; i < heartbeatFunctions.length; i++)
    {
       var hbf = heartbeatFunctions[i];

       hbf.fn.apply(hbf.context, hbf.params);
    }

  }, 1000); //ms
}

///////////////////////////////////////////////////////////////////////////////
function stopHeartbeatTimer() {
  clearInterval(heartbeatTimerId);
}

///////////////////////////////////////////////////////////////////////////////
function registerWithHeartbeatTimer(fn, context, params) {

  heartbeatId++;

  var hbf = { id: heartbeatId, fn: fn, context: context, params: params };

  heartbeatFunctions.push(hbf);

  console.log("registerWithHeartbeatTimer - heartbeatFunctions[] active = " + heartbeatFunctions.length)

  return heartbeatId;
}

///////////////////////////////////////////////////////////////////////////////
function deregisterFromHeartbeatTimer(_heartbeatId) {
  var bFound = false;

  for (var i = 0; (!bFound) && (i < heartbeatFunctions.length); i++)
  {
      var hbf = heartbeatFunctions[i];

      if (hbf.id == _heartbeatId)
      {
        bFound = true;

        heartbeatFunctions.splice(i, 1);
      }
  }

  console.log("deregisterFromHeartbeatTimer - heartbeatFunctions[] active = " + heartbeatFunctions.length)

  return bFound;
}

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
// session helpers
function nextSessionId() {
  sessionId++;
  return sessionId.toString();
}

///////////////////////////////////////////////////////////////////////////////
function findPresenterSessionId(call_options) {
  var presenterId = null; 

  for (var i = 0; (presenterId == null) && (i < sessions.length); i++) {
    if ((typeof sessions[i] !== 'undefined') && (sessions[i] !== null)) {
      if (sessions[i].call_options.mode_selection === "presenter") {
        if (sessions[i].call_options.presentation === call_options.presentation) {
          if (sessions[i].call_options.presenter === call_options.presenter) {
            if (sessions[i].call_options.capture_selection === call_options.capture_selection) {
              presenterId = sessions[i].id;
            }
          }
        }
      }
    }
  }

  return presenterId;
}   

///////////////////////////////////////////////////////////////////////////////
// TODO incremental updating
function publishSessionInfoArray()
{
  var sessionInfoArray = [];

  for (var i = 0; i < sessions.length; i++) {
    if ((typeof sessions[i] !== 'undefined') && (sessions[i] !== null)) {
    
      var sessionInfo = {
        'sessionId'     : sessions[i].id,
        'logged_in_user': sessions[i].logged_in_user,
        'call_options'  : sessions[i].call_options
      };

      sessionInfoArray.push(sessionInfo);
    }
  }

  var message = { id: 'sessionInfoArray', sessionInfoArray: sessionInfoArray };

  broadcastMessage(message);
}

///////////////////////////////////////////////////////////////////////////////
function sendFileInfoArray(ws)
{
  var message = { id: 'fileInfoArray', fileInfoArray: fileInfoArray };

  sendMessage(ws, message);
}

///////////////////////////////////////////////////////////////////////////////
function publishFileInfoArray()
{
  var message = { id: 'fileInfoArray', fileInfoArray: fileInfoArray };

  broadcastMessage(message);
}

///////////////////////////////////////////////////////////////////////////////
function scanFileInfoArray() {
  
  fileInfoArray = []; //reset global

  for (var i = 0; i < startingDirectories.length; i++) {
    walkSync(startingDirectories[i], fileExtensions, fileInfoArray);
  }
}

///////////////////////////////////////////////////////////////////////////////
// List all files in a directory in Node.js recursively in a synchronous fashion
function walkSync(dir, extensions, filelist) {

  if (dir[dir.length-1] != '/') { dir = dir.concat('/'); }

  filelist = filelist || [];

  files = fs.readdirSync(dir);
  
  files.forEach(function(file) {
    try {
      if (fs.statSync(dir + file).isDirectory()) {
        filelist = walkSync(dir + file + '/', extensions, filelist);
      }
      else {
        var bMatched = false;
        
        for (var i = 0; (!bMatched) && (i < extensions.length); i++)
        {
          if (file.length >= extensions[i].length) {
            var file_ext = file.substr(file.length - extensions[i].length, extensions[i].length).toLowerCase(); 

            if (file_ext == extensions[i]) {
              filelist.push({ dir: dir, file: file });
              bMatched = true;
            }
          }
        }  
      }
    }
    catch (e) {
      if (e.code === 'ENOENT') {
        //console.log('File not found!');
      } 
      else if (e.code === 'EACCES') {
        //console.log('File not acessible!');
      } 
      else {
        throw e;
      }      
    }
  });

  return filelist;
}

///////////////////////////////////////////////////////////////////////////////
function createFolders(webinarId, presenterName) {

  // TODO FIX THIS PC 270716  TODO FIX THIS PC 270716  TODO FIX THIS PC 270716
  // TODO FIX THIS PC 270716  TODO FIX THIS PC 270716  TODO FIX THIS PC 270716
  // TODO FIX THIS PC 270716  TODO FIX THIS PC 270716  TODO FIX THIS PC 270716

  if (typeof webinarLastFile[webinarId] === 'undefined' || webinarLastFile[webinarId] === null) {
    webinarLastFile[webinarId] = 0;
  }
  var p = presenterName.split(":");

  var subId = "user_" + p[2] + "_" + webinarLastFile[webinarId].toString();

  if (p[1] === "screenshare") {
    subId = "screen_" + webinarLastFile[webinarId].toString();;
  }

  // mkdirp('/tmp/' + webinarId + '/rec', function(err) {
  //   if (err) { console.log("Error creating pathname " + err); return null; }
  // });

  var _0777 = parseInt('0777', 8);

  var oldmask = process.umask(0);

  fs.mkdir('/tmp/' + webinarId, 0777, function(err) {
    if (err) {
      if (err.code != 'EEXIST') { }; // ignore the error if the folder already exists
    }

    process.umask(0);

    fs.mkdir('/tmp/' + webinarId + '/rec', 0777, function(err) {
      if (err) {
        if (err.code != 'EEXIST') { }; // ignore the error if the folder already exists
      }
    });
  });

//mkdirp('/tmp/' + webinarId + '/rec', { mode: _0777 } );

  process.umask(oldmask);

  var path = '/tmp/' + webinarId + '/rec/' + subId + '.webm';

  console.log("pathname: " + path);

  webinarLastFile[webinarId]++;
  
  return path;
}

///////////////////////////////////////////////////////////////////////////////
//   Management of Database connection
///////////////////////////////////////////////////////////////////////////////
MongoClient.connect(config.mongo_dsn, function(err, d) {
  if (err) {
    console.log("error connecting to mongo " + err);
    return;
  }

  db = d;

  console.log('Connected to mongodb');
});

///////////////////////////////////////////////////////////////////////////////
function writeDocument(collection, data) {
  var col = db.collection(collection);
  col.insert(data, { w: 1 }, function(err, records) {
    if (err) {
      console.log("mongo error: " + err);
    //process.exit(-1);
    } 
    else {
      //console.log("wrote to collection " + collection + " data: " + JSON.stringify(data));
    }
  });
}

///////////////////////////////////////////////////////////////////////////////
// Management of Client <=> Server WebSocket connections
///////////////////////////////////////////////////////////////////////////////

//TODO function broadcastRawMessage() PC 310716
//TODO function sendRawMessage()      PC 310716

///////////////////////////////////////////////////////////////////////////////
function broadcastMessage(message) {
  // now send the info to each client
  for (var i = 0; i < sessions.length; i++) {
    if ((typeof sessions[i] !== 'undefined') && (sessions[i] !== null)) {
      sendMessage(sessions[i].ws, message);
    }
  }
}

///////////////////////////////////////////////////////////////////////////////
function sendMessage(ws, _message) {
  try {  
    var jsonMessage = JSON.stringify(_message);
    
    if (_message.id == "iceCandidate") {
      if (bLogIceCandidateMessages) {   
        console.log('Sending message to Client: ' + jsonMessage);
      }
    }
    else
    {
      console.log('Sending message to Client: ' + jsonMessage);
    }

    // ws.readyState == 0 CONNECTING
    // ws.readyState == 1 OPEN
    // ws.readyState == 2 CLOSING
    // ws.readyState == 3 CLOSED

    ws.send(jsonMessage);
  }
  catch (exception) {
    console.log("Caught exception trying to send outgoing ws message", exception, _message);
  }
}

///////////////////////////////////////////////////////////////////////////////
web_socket_server.on('connection', function(ws) {

  var sessionId = nextSessionId();
  console.log('Connection received with sessionId ' + sessionId);
  
  /////////////////////////////////////
  var session = {
    ws               : ws,
    id               : sessionId,
    logged_in_user   : null,
    call_options     : null,
    pipeline_owner   : null,
    pipeline         : null,
    webRtcEndpoint   : null,
    recorderEndpoint : null,
    recordParams     : null,
    ready            : false,
    presenterId      : null,
    playerEndpoint   : null,
    heartbeatId      : -1
  }
  
  sessions[sessionId] = session;

  publishSessionInfoArray();
  /////////////////////////////////////

  sendFileInfoArray(ws);
  /////////////////////////////////////

  ws.on('error', function(error) {
    console.log('Connection ' + sessionId + ' error');
    stopCall(sessionId);
  });

  ws.on('close', function() {
    console.log('Connection ' + sessionId + ' closed');
    stopCall(sessionId);

    sessions[sessionId] = null;

    publishSessionInfoArray();

    // TODO remove the session, use uuid sessionIds PC 290716
    // TODO remove the session, use uuid sessionIds PC 290716
    // TODO remove the session, use uuid sessionIds PC 290716
  });

  ws.on('message', function(_message) {
    
    try {
      var message = JSON.parse(_message);
      
      if (message.id == 'onIceCandidate') {
        if (bLogIceCandidateMessages) { console.log('Connection ' + sessionId + ' received message onIceCandidate...'); }
      } 
      else if (message.id == 'fileUpload') {
        console.log('Connection ' + sessionId + ' received message fileUpload...');
        console.log("message.file_data.length = " + message.file_data.length);
      }
      else {
        console.log('Connection ' + sessionId + ' received message ', message);
      }


      switch (message.id) 
      {
        case 'start_call':
          startCall(sessionId, ws, message);

          publishSessionInfoArray(); // TODO incremental updates
          break;

        case 'stop_call':
          stopCall(sessionId);

          publishSessionInfoArray(); // TODO incremental updates
          break;

        case 'seekStream':
          seekStream(sessionId, message.offset);
          break;

        case 'pauseStream':
          pauseStream(sessionId);
          break;

        case 'resumeStream':
          resumeStream(sessionId);
          break;

        case 'userLogin':  // VERY TEMP !!!
          sessions[sessionId].logged_in_user = message.logged_in_user;

          publishSessionInfoArray(); // TODO incremental updates
          break;

        case 'userLogout':  // VERY TEMP !!!
          sessions[sessionId].logged_in_user = null;

          publishSessionInfoArray(); // TODO incremental updates
          break;

        case 'scanFileInfoArray':
          scanFileInfoArray();

          publishFileInfoArray();
        break;

        case 'userMessage':
          broadcastMessage(message);
          break;

        case 'fileUpload':
          processFileUpload(message);

          // TODO broadcast availability of file
          break;


        case 'onIceCandidate':
          onIceCandidate(sessionId, message.candidate);
          break;

        default:
          // TODO LOG IT SERVERSIDE AS WELL
          sendMessage({ id: 'error', message: 'Invalid message ' + message });
          break;

      } //switch (message.id)
    }
    catch (exception) {
      console.log("Caught exception trying to process incoming ws message", exception, _message);
    }

  }); //ws.on('message', function(_message) 

});

///////////////////////////////////////////////////////////////////////////////
//  Definition of functions
///////////////////////////////////////////////////////////////////////////////
// Recover kurentoClient for the first time.
function getKurentoClient(callback) {
  if (kurentoClient !== null) {
    return callback(null, kurentoClient);
  }

  kurento(argv.ws_uri, function(error, _kurentoClient) {
    if (error) {
      console.log("Could not find media server at address " + argv.ws_uri);
      return callback("Could not find media server at address" + argv.ws_uri + ". Exiting with error " + error);
    }

    kurentoClient = _kurentoClient;

    callback(null, kurentoClient);
  });
}

///////////////////////////////////////////////////////////////////////////////
function startCall(sessionId, ws, message) {
  if (message.call_options.mode_selection == "viewer") {
    if (message.call_options.replay_selection == "live")
    {
      startLiveViewer(sessionId, ws, message.call_options, message.sdpOffer, function(error, sdpAnswer) {
        if (error) {
          return sendMessage(ws, { id: 'start_call_answer', response: 'rejected', message: error });
        }
        
        sendMessage(ws, { id: 'start_call_answer', response: 'accepted', sdpAnswer: sdpAnswer });
      });
    }
    else if (message.call_options.replay_selection == "recording") {
      startRecordingViewer(sessionId, ws, message.call_options, message.sdpOffer, function(error, sdpAnswer) {
        if (error) {
          return sendMessage(ws, { id: 'start_call_answer', response: 'rejected', message: error });
        }
        
        sendMessage(ws, { id: 'start_call_answer', response: 'accepted', sdpAnswer: sdpAnswer });
      });
    }
    else if (message.call_options.replay_selection == "recorded") {
      startRecordingViewer(sessionId, ws, message.call_options, message.sdpOffer, function(error, sdpAnswer) {
        if (error) {
          return sendMessage(ws, { id: 'start_call_answer', response: 'rejected', message: error });
        }
        
        sendMessage(ws, { id: 'start_call_answer', response: 'accepted', sdpAnswer: sdpAnswer });
      });
    }
    else {
      // Why are we here ??? Unknown call_options.replay_selection 
    } 
  }
  else if (message.call_options.mode_selection == "presenter") {
    if (message.call_options.recording_selection == "none")
    {
      startLivePresenter(sessionId, ws, message.call_options, message.sdpOffer, function(error, sdpAnswer) {
        if (error) {
          return sendMessage(ws, { id: 'start_call_answer', response: 'rejected', message: error });
        }

        sendMessage(ws, { id: 'start_call_answer', response: 'accepted', presenterId: sessionId, sdpAnswer: sdpAnswer });
      });
    }
    else
    {
      startRecordingPresenter(sessionId, ws, message.call_options, message.sdpOffer, function(error, sdpAnswer) {
        if (error) {
          return sendMessage(ws, { id: 'start_call_answer', response: 'rejected', message: error });
        }

        sendMessage(ws, { id: 'start_call_answer', response: 'accepted', presenterId: sessionId, sdpAnswer: sdpAnswer });
      });
    }
  }
  else 
  {
    // Why are we here ??? Unknown options.mode_selection !!!
    console.log("Unknown message.call_options.mode_selection !!!");
  }
}

///////////////////////////////////////////////////////////////////////////////
function startLivePresenter(sessionId, ws, call_options, sdpOffer, callback) {
  clearIceCandidatesQueue(sessionId);

  /////////////////////////////////////

  // TODO workout if we are already on a call, deal with multiple calls etc PC 290716  
  // TODO workout if we are already on a call, deal with multiple calls etc PC 290716  
  // TODO workout if we are already on a call, deal with multiple calls etc PC 290716  
  session = sessions[sessionId];

  session.call_options = call_options;

  /////////////////////////////////////
  getKurentoClient(function(error, kurentoClient) {
    if (handleStandardPipelineError(session, error, callback)) { return; }

    kurentoClient.create('MediaPipeline', function(error, pipeline) {
      if (handleStandardPipelineError(session, error, callback)) { return; };

      // we own the pipeline
      session.pipeline_owner = session.id; 
      session.pipeline       = pipeline;
      
      session.pipeline.create('WebRtcEndpoint', function(error, webRtcEndpoint) {
        if (handleStandardPipelineError(session, error, callback)) { return; }

        session.webRtcEndpoint = webRtcEndpoint;

        sendIceCandidatesQueue(sessionId);

        session.webRtcEndpoint.on('OnIceCandidate', function(event) {
          var candidate = kurento.register.complexTypes.IceCandidate(event.candidate);
          sendMessage(ws, { id: 'iceCandidate', candidate: candidate });
        });

        session.webRtcEndpoint.processOffer(sdpOffer, function(error, sdpAnswer) {
          if (handleStandardPipelineError(session, error, callback)) { return; }

          if (typeof sessions[sessionId] === 'undefined' || sessions[sessionId] === null) {
            if (handleStandardPipelineError(session, noPresenterMessage, callback)) { return; }
          }

          console.log("Presenter " + sessionId + " ready.");
          session.ready = true;

          callback(null, sdpAnswer);
        });

        console.log("invoking gatherCandidates");
        session.webRtcEndpoint.gatherCandidates(function(error) {
          if (handleStandardPipelineError(session, error, callback)) { return; }
        });

      });
    });
  });
}

///////////////////////////////////////////////////////////////////////////////
function startRecordingPresenter(sessionId, ws, call_options, sdpOffer, callback) {
  clearIceCandidatesQueue(sessionId);

  /////////////////////////////////////

  // TODO workout if we are already on a call, deal with multiple calls etc PC 290716  
  // TODO workout if we are already on a call, deal with multiple calls etc PC 290716  
  // TODO workout if we are already on a call, deal with multiple calls etc PC 290716  
  session = sessions[sessionId];

  session.call_options = call_options;

  /////////////////////////////////////
  getKurentoClient(function(error, kurentoClient) {
    if (handleStandardPipelineError(session, error, callback)) { return; }

    kurentoClient.create('MediaPipeline', function(error, pipeline) {
      if (handleStandardPipelineError(session, error, callback)) { return; };

      // we own the pipeline
      session.pipeline_owner = session.id; 
      session.pipeline       = pipeline;
      
//START OF RECORDING SETUP
//START OF RECORDING SETUP
//START OF RECORDING SETUP

      var recordParams = {
        uri: "",
        mediaProfile: ""
      };

      var file_extension = "";

      /////////////////////////////
      // MediaProfileSpecType.KURENTO_SPLIT_RECORDER 
      // MediaProfileSpecType.MP4 
      // MediaProfileSpecType.MP4_AUDIO_ONLY 
      // MediaProfileSpecType.MP4_VIDEO_ONLY 
      // MediaProfileSpecType.WEBM 
      // MediaProfileSpecType.WEBM_AUDIO_ONLY 
      // MediaProfileSpecType.WEBM_VIDEO_ONLY 

      if (call_options.recording_selection == "none") {
        // Why are we here ???
      }
      else if (call_options.recording_selection == "webm") {
        if (call_options.audio && call_options.video) {
          recordParams.mediaProfile = "WEBM";
          file_extension = "webm";
        }
        else if (call_options.video) {
          recordParams.mediaProfile = "WEBM_VIDEO_ONLY";
          file_extension = "webm";
        }
        else if (call_options.audio) {
          recordParams.mediaProfile = "WEBM_AUDIO_ONLY";
          file_extension = "webm";
        }
        else {
          // Why are we here ???
        }
      }
      else if (call_options.recording_selection == "mpeg4") {
        if (call_options.audio && call_options.video) {
          recordParams.mediaProfile = "MP4";
          file_extension = "mp4";
        }
        else if (call_options.video) {
          recordParams.mediaProfile = "MP4_VIDEO_ONLY";
          file_extension = "mp4";
        }
        else if (call_options.audio) {
          recordParams.mediaProfile = "MP4_AUDIO_ONLY"; // TODO file extension to .mp3 
          file_extension = "mp3";
        }
        else {
          // Why are we here ???
        }
      }
      else {
        // Why are we here ???
      }
      
      /////////////////////////////

      // var elements = [{
      //   type: 'RecorderEndpoint',
      //   params: {
      //     uri: file_uri,
      //     mediaProfile: profile
      //   }
      // }, ]
      //
      // var Elements = [];
      // pipeline.create(elements, function(error, Elements) {

      /////////////////////////////

      // TODO This needs to convert non legal filename characters !!! PC 270716
      // TODO This needs to convert non legal filename characters !!! PC 270716
      // TODO This needs to convert non legal filename characters !!! PC 270716

//      // var pathname = createFolders(webinarId, presenterName);
//      // session.path = pathname;
//      // session.file = pathname.substring(pathname.lastIndexOf("/") + 1);

      var date      = new Date();
      var timeRegex = /^.*T(\d{2}):(\d{2}):(\d{2}).*$/
      var dateRegex = /^(\d{4})-(\d{2})-(\d{2})T.*$/
      var dateData  = dateRegex.exec(date.toJSON());
      var timeData  = timeRegex.exec(date.toJSON());
      var today     = dateData[1] + dateData[2] + dateData[3];
      var now       = timeData[1] + timeData[2] + timeData[3];

      var filename = call_options.presentation + "_" + call_options.presenter + "_" + call_options.capture_selection + "_" + today + "_" + now; 

      recordParams.uri =  "file:///tmp/" + filename + "." + file_extension;

      session.recordParams = recordParams;
  
      console.log("recordParams.uri = " + recordParams.uri);
      /////////////////////////////////

      session.pipeline.create('RecorderEndpoint', session.recordParams, function(error, recorderEndpoint) {
        if (handleStandardPipelineError(session, error, callback)) { return; }
        
        session.recorderEndpoint = recorderEndpoint;

//END OF RECORDING SETUP
//END OF RECORDING SETUP
//END OF RECORDING SETUP
        
        session.pipeline.create('WebRtcEndpoint', function(error, webRtcEndpoint) {
          if (handleStandardPipelineError(session, error, callback)) { return; }

          session.webRtcEndpoint = webRtcEndpoint;

//START OF RECORDING SETUP
//START OF RECORDING SETUP
//START OF RECORDING SETUP

          ///////////////////////////////////////////////////
          // webrtc endpoint listeners
          session.webRtcEndpoint.on('MediaStateChanged', (event) => {

            console.log("session.webRtcEndpoint.on('MediaStateChanged', (event) =>", event);

            if ((event.oldState !== event.newState) && (event.newState === 'CONNECTED')) {
              console.log("session.recorderEndpoint.record()");

              // start recording now
              session.recorderEndpoint.record(error => { console.log("error: ", error) });
            }
          });

          ///////////////////////////////////////////////////
          // recorder endpoint listeners
          session.recorderEndpoint.on('Recording', (event) => { 
            console.log("session.recorderEndpoint.on('Recording', (event)", event);

            var message = { id: 'recordingStateChange', state: true };
            
            sendMessage(session.ws, message); 
          });
          
          session.recorderEndpoint.on('Paused'                  , (event) => { console.log("session.recorderEndpoint.on('Paused'                 , (event)", event); });
          session.recorderEndpoint.on('Stopped'                 , (event) => { console.log("session.recorderEndpoint.on('Stopped'                , (event)", event); });
          //session.recorderEndpoint.on('MediaStateChanged'     , (event) => { console.log("session.recorderEndpoint.on('MediaStateChanged'      , (event)", event); });
          //session.recorderEndpoint.on('MediaSessionTerminated', (event) => { console.log("session.recorderEndpoint.on('MediaSessionTerminated' , (event)", event); });
          //session.recorderEndpoint.on('MediaSessionStarted'   , (event) => { console.log("session.recorderEndpoint.on('MediaSessionStarted'    , (event)", event); });
          //session.recorderEndpoint.on('ConnectionStateChanged', (event) => { console.log("session.recorderEndpoint.on('ConnectionStateChanged' , (event)", event); });
          session.recorderEndpoint.on('ElementConnected'        , (event) => { console.log("session.recorderEndpoint.on('ElementConnected'       , (event)", event); });
          session.recorderEndpoint.on('ElementDisconnected'     , (event) => { console.log("session.recorderEndpoint.on('ElementDisconnected'    , (event)", event); });
          session.recorderEndpoint.on('MediaFlowOutStateChange' , (event) => { console.log("session.recorderEndpoint.on('MediaFlowOutStateChange', (event)", event); });
          session.recorderEndpoint.on('MediaFlowInStateChange'  , (event) => { console.log("session.recorderEndpoint.on('MediaFlowInStateChange' , (event)", event); });
          ///////////////////////////////////////////////////

          /////////////////////////////
          // connect the pipeline
         if (call_options.audio && call_options.video) {
            console.log("webRtcEndpoint.connect(recorderEndpoint) audiovideo");
            
            session.webRtcEndpoint.connect(session.recorderEndpoint, function(error) {
              if (error !== null) { console.log("audiovideo recording fails: " + error); }
            });
          }
          else if (call_options.video) {
            console.log("webRtcEndpoint.connect(recorderEndpoint) video only");
            
            session.webRtcEndpoint.connect(session.recorderEndpoint, 'VIDEO', function(error) {
              if (error !== null) { console.log("video only recording fails: " + error); }
            });
          }
          else if (call_options.audio) {
            console.log("webRtcEndpoint.connect(recorderEndpoint) audio only");
            
            session.webRtcEndpoint.connect(session.recorderEndpoint, 'AUDIO', function(error) {
              if (error !== null) { console.log("audio only recording fails: " + error); }
            });
          }
          else {
            // Why are we here ???
          }
          /////////////////////////////

//END OF RECORDING SETUP
//END OF RECORDING SETUP
//END OF RECORDING SETUP

          sendIceCandidatesQueue(sessionId);

          session.webRtcEndpoint.on('OnIceCandidate', function(event) {
            var candidate = kurento.register.complexTypes.IceCandidate(event.candidate);
            sendMessage(ws, { id: 'iceCandidate', candidate: candidate });
          });

          session.webRtcEndpoint.processOffer(sdpOffer, function(error, sdpAnswer) {
            if (handleStandardPipelineError(session, error, callback)) { return; }

            if (typeof sessions[sessionId] === 'undefined' || sessions[sessionId] === null) {
              if (handleStandardPipelineError(session, noPresenterMessage, callback)) { return; }
            }

            console.log("Presenter " + sessionId + " ready.");
            session.ready = true;

            callback(null, sdpAnswer);
          });

          console.log("invoking gatherCandidates");
          session.webRtcEndpoint.gatherCandidates(function(error) {
            if (handleStandardPipelineError(session, error, callback)) { return; }
          });

        });
      });
    });
  });
}

///////////////////////////////////////////////////////////////////////////////
function startLiveViewer(sessionId, ws, call_options, sdpOffer, callback) {
  clearIceCandidatesQueue(sessionId);
  
  /////////////////////////////////////

  // TODO workout if we are already on a call, deal with multiple calls etc PC 290716  
  // TODO workout if we are already on a call, deal with multiple calls etc PC 290716  
  // TODO workout if we are already on a call, deal with multiple calls etc PC 290716  
  session = sessions[sessionId];

  session.call_options = call_options;
  /////////////////////////////////////

  var presenterId = findPresenterSessionId(call_options);

  if (presenterId != null) {
    session.presenterId = presenterId;

    // presenter owns the pipeline
    session.pipeline_owner = sessions[presenterId].pipeline_owner; 
    session.pipeline       = sessions[presenterId].pipeline;
  }
  else {
    if (handleStandardPipelineError(session, noPresenterMessage, callback)) { return; }

  }   

  // if (typeof sessions[presenterId] === 'undefined' || sessions[presenterId] === null || sessions[presenterId].ready == 0) {
  //   stopCall(sessionId);

  //   console.log("no presenter " + presenterId);
  //   return callback(noPresenterMessage);
  // }

  session.pipeline.create('WebRtcEndpoint', function(error, webRtcEndpoint) {
    if (handleStandardPipelineError(session, error, callback)) { return; }

    session.webRtcEndpoint = webRtcEndpoint;

    // if (typeof sessions[presenterId] === 'undefined' || sessions[presenterId] === null) {
    //   console.log("2 no presenter " + presenterId);
    //   stopCall(sessionId);
    //   return callback(noPresenterMessage);
    // }

    sendIceCandidatesQueue(sessionId);

    webRtcEndpoint.on('OnIceCandidate', function(event) {
      var candidate = kurento.register.complexTypes.IceCandidate(event.candidate);
      if (ws.readyState != 1) {
        console.log("ws closed!\n");
        return;
      }

      sendMessage(ws, { id: 'iceCandidate', candidate: candidate });
    });

    webRtcEndpoint.processOffer(sdpOffer, function(error, sdpAnswer) {
      if (handleStandardPipelineError(session, error, callback)) { return; }

      if (typeof sessions[presenterId] === 'undefined' || sessions[presenterId] === null) {
        if (handleStandardPipelineError(session, noPresenterMessage, callback)) { return; }
      }


      if (session.call_options.replay_processing == "none") {
        sessions[presenterId].webRtcEndpoint.connect(webRtcEndpoint, function(error) {
          if (handleStandardPipelineError(session, error, callback)) { return; }

          if (typeof sessions[presenterId] === 'undefined' || sessions[presenterId] === null) {
            if (handleStandardPipelineError(session, noPresenterMessage, callback)) { return; }
          }

          callback(null, sdpAnswer);
          
          console.log("invoking gatherCandidates");
          session.webRtcEndpoint.gatherCandidates(function(error) {
            if (handleStandardPipelineError(session, error, callback)) { return; }
          }); //session.webRtcEndpoint.gatherCandidates(function(error) 

        }); //sessions[presenterId].webRtcEndpoint.connect(webRtcEndpoint, function(error)
      }
      else if (session.call_options.replay_processing == "faceoverlay") {
        sessions[presenterId].pipeline.create('FaceOverlayFilter', function(error, faceOverlayFilter) {
          if (handleStandardPipelineError(session, error, callback)) { return; }

          // 'img/mario-wings.png', -0.35, -1.20, 1.60, 1.60
          // 'img/mario-wings.png',  0.50,  0.50, 0.20, 0.20
          // 'img/wizard.png'     , -0.20, -1.35, 1.50, 1.50
      
          faceOverlayFilter.setOverlayedImage(url.format(asUrl) + 'img/wizard.png', -0.20, -1.15, 1.25, 1.25, function(error) {
            if (handleStandardPipelineError(session, error, callback)) { return; }

            sessions[presenterId].faceOverlayFilter = faceOverlayFilter;

            sessions[presenterId].webRtcEndpoint.connect(sessions[presenterId].faceOverlayFilter, function(error) {
              if (handleStandardPipelineError(session, error, callback)) { return; }

              sessions[presenterId].faceOverlayFilter.connect(webRtcEndpoint, function(error) {
                if (handleStandardPipelineError(session, error, callback)) { return; }

                if (typeof sessions[presenterId] === 'undefined' || sessions[presenterId] === null) {
                  if (handleStandardPipelineError(session, noPresenterMessage, callback)) { return; }
                }

                callback(null, sdpAnswer);
                
                console.log("invoking gatherCandidates");
                session.webRtcEndpoint.gatherCandidates(function(error) {
                  if (handleStandardPipelineError(session, error, callback)) { return; }
                }); // session.webRtcEndpoint.gatherCandidates(function(error) 

              }); // sessions[presenterId].faceOverlayFilter.connect(webRtcEndpoint, function(error)
            }); // sessions[presenterId].webRtcEndpoint.connect(sessions[presenterId].faceOverlayFilter, function(error)
          }); // faceOverlayFilter.setOverlayedImage(url.format(asUrl)
        }); // sessions[presenterId].create('FaceOverlayFilter', function(error, faceOverlayFilter)
      }
      else {
        // Why are we here ??? Unknown call_options.replay_processing mode
      }

    }); // webRtcEndpoint.processOffer(sdpOffer, function(error, sdpAnswer) 

  }); // sessions[presenterId].pipeline.create('WebRtcEndpoint', function(error, webRtcEndpoint) 
}

///////////////////////////////////////////////////////////////////////////////
function startRecordingViewer(sessionId, ws, call_options, sdpOffer, callback) {
  clearIceCandidatesQueue(sessionId);
  
  /////////////////////////////////////

  // TODO workout if we are already on a call, deal with multiple calls etc PC 290716  
  // TODO workout if we are already on a call, deal with multiple calls etc PC 290716  
  // TODO workout if we are already on a call, deal with multiple calls etc PC 290716  
  session = sessions[sessionId];

  session.call_options = call_options;
  /////////////////////////////////////

  var uri     = null;
  var profile = null;

  if (session.call_options.replay_selection == "recording") {
    var presenterId = findPresenterSessionId(call_options);

    if (presenterId != null) {
      session.presenterId = presenterId;
    }
    else {
      if (handleStandardPipelineError(session, noPresenterMessage, callback)) { return; }
    }   

    uri = sessions[presenterId].recordParams.uri;
  }
  else if (session.call_options.replay_selection == "recorded") {
    uri = 'file://' + session.call_options.presentation;
  }
  else {
    // Why are we here ???
  }

  var replay_params = { uri: uri, mediaProfile: profile }; 

  /////////////////////////////////////
  getKurentoClient(function(error, kurentoClient) {
    if (handleStandardPipelineError(session, error, callback)) { return; }

    kurentoClient.create('MediaPipeline', function(error, pipeline) {
      if (handleStandardPipelineError(session, error, callback)) { return; };

      // we own the pipeline
      session.pipeline_owner = session.id; 
      session.pipeline       = pipeline;
 
      session.pipeline.create('WebRtcEndpoint', function(error, webRtcEndpoint) {
        if (handleStandardPipelineError(session, error, callback)) { return; }

        session.webRtcEndpoint = webRtcEndpoint;

        session.pipeline.create('PlayerEndpoint', replay_params, function(error, playerEndpoint) {
          if (handleStandardPipelineError(session, error, callback)) { return; }

          session.playerEndpoint = playerEndpoint;


          sendIceCandidatesQueue(sessionId);

          session.webRtcEndpoint.on('OnIceCandidate', function(event) {
            var candidate = kurento.register.complexTypes.IceCandidate(event.candidate);
            if (ws.readyState != 1) {
              console.log("ws closed!\n");
              return;
            }

            sendMessage(ws, { id: 'iceCandidate', candidate: candidate });
          });

          session.webRtcEndpoint.processOffer(sdpOffer, function(error, sdpAnswer) {
            if (handleStandardPipelineError(session, error, callback)) { return; }


            if (session.call_options.replay_processing == "none") {
              session.playerEndpoint.connect(session.webRtcEndpoint, function(error) {
                if (handleStandardPipelineError(session, error, callback)) { return; }

                callback(null, sdpAnswer);
                
                console.log("invoking gatherCandidates");
                session.webRtcEndpoint.gatherCandidates(function(error) {
                  if (handleStandardPipelineError(session, error, callback)) { return; }
                }); 

                session.playerEndpoint.on('EndOfStream', (event) => { 
                  console.log("session.playerEndpoint.on('End', (event)", event); 
                
                  deregisterFromHeartbeatTimer(session.heartbeatId);
                  session.heartbeatId = -1;
                });

                session.playerEndpoint.play();

                /////////////////////////////////
                session.heartbeatId = registerWithHeartbeatTimer(sendStreamInfo, undefined, [session.id]);
                /////////////////////////////////

              }); //sessions[presenterId].webRtcEndpoint.connect(webRtcEndpoint, function(error)
            }
            else if (session.call_options.replay_processing == "faceoverlay") {
              session.pipeline.create('FaceOverlayFilter', function(error, faceOverlayFilter) {
                if (handleStandardPipelineError(session, error, callback)) { return; }

                // 'img/mario-wings.png', -0.35, -1.20, 1.60, 1.60
                // 'img/mario-wings.png',  0.50,  0.50, 0.20, 0.20
                // 'img/wizard.png'     , -0.20, -1.35, 1.50, 1.50
            
                faceOverlayFilter.setOverlayedImage(url.format(asUrl) + 'img/wizard.png', -0.20, -1.15, 1.25, 1.25, function(error) {
                  if (handleStandardPipelineError(session, error, callback)) { return; }

                  session.faceOverlayFilter = faceOverlayFilter;

                  session.playerEndpoint.connect(session.faceOverlayFilter, function(error) {
                    if (handleStandardPipelineError(session, error, callback)) { return; }

                    session.faceOverlayFilter.connect(session.webRtcEndpoint, function(error) {
                      if (handleStandardPipelineError(session, error, callback)) { return; }

                      callback(null, sdpAnswer);
                      
                      console.log("invoking gatherCandidates");
                      session.webRtcEndpoint.gatherCandidates(function(error) {
                        if (handleStandardPipelineError(session, error, callback)) { return; }
                      });

                      session.playerEndpoint.on('EndOfStream', (event) => { 
                        console.log("session.playerEndpoint.on('End', (event)", event); 
                      
                        deregisterFromHeartbeatTimer(session.heartbeatId);
                        session.heartbeatId = -1;
                      });

                      session.playerEndpoint.play();

                      /////////////////////////////////
                      session.heartbeatId = registerWithHeartbeatTimer(sendStreamInfo, undefined, [session.id]);
                      /////////////////////////////////

                    }); // sessions[presenterId].faceOverlayFilter.connect(webRtcEndpoint, function(error)
                  }); // sessions[presenterId].webRtcEndpoint.connect(sessions[presenterId].faceOverlayFilter, function(error)
                }); // faceOverlayFilter.setOverlayedImage(url.format(asUrl)
              }); // sessions[presenterId].create('FaceOverlayFilter', function(error, faceOverlayFilter)
            }
            else {
              // Why are we here ??? Unknown call_options.replay_processing mode
            }

          }); // webRtcEndpoint.processOffer(sdpOffer, function(error, sdpAnswer) 

        }); // sessions[presenterId].pipeline.create('WebRtcEndpoint', function(error, webRtcEndpoint)
      });
    });
  }); 
}

///////////////////////////////////////////////////////////////////////////////
function SecondsToHHMMSS(totalSeconds) {
  var hours   = Math.floor(totalSeconds / 3600);
  var minutes = Math.floor((totalSeconds - (hours * 3600)) / 60);
  var seconds = totalSeconds - (hours * 3600) - (minutes * 60);
      seconds = Math.floor(seconds);

  var result = (hours < 10 ? "0" + hours : hours);
      result += ":" + (minutes < 10 ? "0" + minutes : minutes);
      result += ":" + (seconds < 10 ? "0" + seconds : seconds);

    return result;
}

///////////////////////////////////////////////////////////////////////////////
function pauseStream(sessionId) 
{
  /////////////////////////////////
  session = sessions[sessionId];
  /////////////////////////////////

  if ((session != null) && (session.playerEndpoint != null)) {
    session.playerEndpoint.pause();
  }
}

///////////////////////////////////////////////////////////////////////////////
function resumeStream(sessionId) 
{
  /////////////////////////////////
  session = sessions[sessionId];
  /////////////////////////////////

  if ((session != null) && (session.playerEndpoint != null)) {
    session.playerEndpoint.play();
  }
}

///////////////////////////////////////////////////////////////////////////////
function seekStream(sessionId, offset) 
{
  /////////////////////////////////
  session = sessions[sessionId];
  /////////////////////////////////

  if ((session != null) && (session.playerEndpoint != null)) {
    session.playerEndpoint.getVideoInfo(function(error, videoInfo) {
      if (error) { console.log('session.playerEndpoint.getVideoInfo()', error); return; }

      session.playerEndpoint.getPosition(function(error, result) {

        console.log('session.playerEndpoint.getPosition() ', result, SecondsToHHMMSS((result/1000)));

        console.log('session.playerEndpoint.getVideoInfo() videoInfo.duration     = ' + videoInfo.duration    );
        console.log('session.playerEndpoint.getVideoInfo() videoInfo.isSeekable   = ' + videoInfo.isSeekable  );
        console.log('session.playerEndpoint.getVideoInfo() videoInfo.seekableInit = ' + videoInfo.seekableInit);
        console.log('session.playerEndpoint.getVideoInfo() videoInfo.seekableEnd  = ' + videoInfo.seekableEnd, SecondsToHHMMSS((videoInfo.seekableEnd/1000)));

        if (videoInfo.isSeekable) {
          var position     = result + offset;
          var reachableEnd = videoInfo.seekableEnd; 

          if (position > reachableEnd) { position = reachableEnd; }
          if (position <            0) { position = 0;            }

          session.playerEndpoint.setPosition(position);
          
          sendMessage(session.ws, { id: 'seekStreamResponse', isSeekable: true, seekableInit: videoInfo.seekableInit, seekableEnd: videoInfo.seekableEnd, oldPosition: result, newPosition: position });
        }
        else {
          sendMessage(session.ws, { id: 'seekStreamResponse', isSeekable: false });
        }

      });
    });
  }
}

///////////////////////////////////////////////////////////////////////////////
function sendStreamInfo(sessionId) 
{
  /////////////////////////////////
  session = sessions[sessionId];
  /////////////////////////////////

  if ((session != null) && (session.playerEndpoint != null)) {
    session.playerEndpoint.getVideoInfo(function(error, videoInfo) {
      if (error) { console.log('session.playerEndpoint.getVideoInfo()', error); }
      
      session.playerEndpoint.getPosition(function(error, position) {
        if (error) { console.log('session.playerEndpoint.getPosition()', error); }

        // console.log('session.playerEndpoint.getPosition()                         = ' + position              );
        // console.log('session.playerEndpoint.getVideoInfo() videoInfo.duration     = ' + videoInfo.duration    );
        // console.log('session.playerEndpoint.getVideoInfo() videoInfo.isSeekable   = ' + videoInfo.isSeekable  );
        // console.log('session.playerEndpoint.getVideoInfo() videoInfo.seekableInit = ' + videoInfo.seekableInit);
        // console.log('session.playerEndpoint.getVideoInfo() videoInfo.seekableEnd  = ' + videoInfo.seekableEnd );

        sendMessage(session.ws, { id: 'streamInfo', position: position, duration: videoInfo.duration, isSeekable: videoInfo.isSeekable, seekableInit: videoInfo.seekableInit, seekableEnd: videoInfo.seekableEnd });
      });
    });
  }
}

///////////////////////////////////////////////////////////////////////////////
function stopCall(sessionId) {
  if ((typeof sessions[sessionId] !== 'undefined') && (sessions[sessionId] !== null)) {
    var session       = sessions[sessionId];
    var teardownDelay = 100; //ms

    deregisterFromHeartbeatTimer(session.heartbeatId);
    session.heartbeatId = -1;

    // invalidate any presenter session so no one can connect to it
    if ((session.call_options != null) && (session.call_options.mode_selection == "presenter")) {
      session.ready = false;

      for (var i = 0; i < sessions.length; i++) {
        var other_session = sessions[i];

        // request other sessions that are viewer's of this presenter to stop
        if ((other_session != null) && (other_session.presenterId == sessionId)) {
          if (other_session.ws) {
            sendMessage(other_session.ws, { id: 'stopCommunication' });

            teardownDelay = 1000; //ms
          }
        }
      }
    }
    else if ((session.call_options != null) && (session.call_options.mode_selection == "viewer")) {
      // TODO any viewer specific teardown
    }
    else {
      // Why are we here ??? Unknown session.call_options.mode_selection !!!
    }

    ///////////////////////////////////
    // universal teardown
    teardownPipeline(session);   

    ///////////////////////////////////
    // cleanup the session
  //session.ws               = ws;
  //session.id               = sessionId;
  //session.logged_in_user   = null;
    session.call_options     = null;
    session.pipeline_owner   = null;
    session.pipeline         = null;
    session.webRtcEndpoint   = null;
    session.recorderEndpoint = null;
    session.recordParams     = null;
    session.ready            = false;
    session.presenterId      = null;
    session.playerEndpoint   = null;
    session.heartbeatId      = -1;

  }
}

///////////////////////////////////////////////////////////////////////////////
// pipeline helpers
///////////////////////////////////////////////////////////////////////////////
function teardownPipeline(session) {
  if (session.recorderEndpoint != null) {
    // stop() and wait ...
    session.recorderEndpoint.stop();

    session.recorderEndpoint.release();
    session.recorderEndpoint = null;
  }

  if (session.playerEndpoint != null) {
    session.playerEndpoint.stop();

    session.playerEndpoint.release();
    session.playerEndpoint = null;
  }

  if (session.webRtcEndpoint != null) {
    session.webRtcEndpoint.release();
    session.webRtcEndpoint = null;
  }
  
  if (session.pipeline_owner == session.id) {
    //  we own the pipeline
    if (session.pipeline != null ) {
      session.pipeline.release();
      session.pipeline = null;
    }
  }

  clearIceCandidatesQueue(sessionId);
}

///////////////////////////////////////////////////////////////////////////////
function handleStandardPipelineError(session, error, callback) {
  var bError = false;

  if (error) {
    bError = true;

    stopCall(session.id);
    
    if (callback) {
      callback(error);
    }
  }

  return bError;
}

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
// ice candidate exchange management helpers
function onIceCandidate(sessionId, _candidate) {
  var candidate = kurento.register.complexTypes.IceCandidate(_candidate);

  if (sessions[sessionId] && sessions[sessionId].webRtcEndpoint) {
    if (bLogIceCandidateMessages) { console.log('Sending session ice candidate to kurento-media-server'); }
    sessions[sessionId].webRtcEndpoint.addIceCandidate(candidate);
  } 
  else {
    if (bLogIceCandidateMessages) { console.log('Queueing session ice candidate'); }

    if (!iceCandidatesQueues[sessionId]) {
      iceCandidatesQueues[sessionId] = [];
    }
    iceCandidatesQueues[sessionId].push(candidate);
  }
}

///////////////////////////////////////////////////////////////////////////////
function sendIceCandidatesQueue(sessionId) {
  if (sessions[sessionId] && sessions[sessionId].webRtcEndpoint) {
    if (iceCandidatesQueues[sessionId]) {
      while (iceCandidatesQueues[sessionId].length) {
        var candidate = iceCandidatesQueues[sessionId].shift();

        if (bLogIceCandidateMessages) { console.log('Sending queued session ice candidate to kurento-media-server'); }

        sessions[sessionId].webRtcEndpoint.addIceCandidate(candidate);
      }
    }
  }
}

///////////////////////////////////////////////////////////////////////////////
function clearIceCandidatesQueue(sessionId) {
  if (iceCandidatesQueues[sessionId]) {
    delete iceCandidatesQueues[sessionId];
  }
}

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

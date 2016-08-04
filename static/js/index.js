// (C) Copyright 2014-2015 Kurento (http://kurento.org/)
// (C) Copyright 2016-2016 Luddite Enterprises
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
 
 
var ws = new WebSocket('wss://' + location.host + '/classroom');

var video_player_1   = null;
var webRtcPeer       = null;

var sessionInfoArray = []; // all the clients currently connected to the server

var logged_in_user   = ""; // TEMP 

var fileInfoArray = [];

///////////////////////////////////////////////////////////////////////////////
function setOptions(call_options)
{
  // <div class="call_options"> 
  //   <input type="radio" name="mode_selection" value="viewer">
  //   <input type="radio" name="mode_selection" value="presenter">              

  if (call_options.mode_selection == "viewer") {
    $(".presenter_options").hide();
    $(".viewer_options" ).show();
  //     <input type="radio" name="replay_selection" value="live">
  //     <input type="radio" name="replay_selection" value="recording">

  //     <input type="radio" name="replay_processing" value="none">
  //     <input type="radio" name="replay_processing" value="faceoverlay">
  }
  else if (call_options.mode_selection == "presenter") {
    $(".presenter_options").show();
    $(".viewer_options" ).hide();
  //     <input type="text" name="presenter">
  //     <input type="text" name="presentation">

  //     <input type="radio" name="capture_selection" value="webcam">
  //     <input type="radio" name="capture_selection" value="screen">

  //     <label><input type="checkbox" id="audio" value="audio">              
  //     <label><input type="checkbox" id="video" value="video">
  //     <label><input type="checkbox" id="record" value="record">
  }
  else {
    // Why are we here ??? Unknown options.mode_selection !!!
  }

}

///////////////////////////////////////////////////////////////////////////////
function getOptions()
{
  var call_options = {};

  call_options.mode_selection = $('input[name=mode_selection]:checked').val();

  if (call_options.mode_selection == "viewer")
  {
    call_options.presenter               = "";
    call_options.presentation            = "";
    call_options.capture_selection       = "";
    call_options.replay_selection        = "";

    var data = $('#presentation_selection').val();
    
    if (data) {
      var sessionInfo = JSON.parse(data);

      call_options.presenter             = sessionInfo.call_options.presenter;
      call_options.presentation          = sessionInfo.call_options.presentation;
      call_options.capture_selection     = sessionInfo.call_options.capture_selection;
      call_options.replay_selection      = sessionInfo.call_options.replay_selection;
    }
    else {
      var data = $('#file_selection').val();
      
      if (data) {
        var sessionInfo = JSON.parse(data);

        call_options.presenter             = sessionInfo.call_options.presenter;
        call_options.presentation          = sessionInfo.call_options.presentation;
        call_options.capture_selection     = sessionInfo.call_options.capture_selection;
        call_options.replay_selection      = sessionInfo.call_options.replay_selection;
      }      
    }

    call_options.replay_processing       = $('input[name=replay_processing]:checked').val();
  }
  else if (call_options.mode_selection == "presenter") {
    call_options.presenter               = $('input:text[name=presenter]').val();
    call_options.presentation            = $('input:text[name=presentation]').val();

    call_options.capture_selection       = $('input[name=capture_selection]:checked').val();
    
    call_options.audio                   = $('#audio' ).is(':checked')             
    call_options.video                   = $('#video' ).is(':checked') 

    call_options.recording_selection     = $('input[name=recording_selection]:checked').val();
  } 
  else {
    // Why are we here ??? Unknown call_options.mode_selection !!!
  }

  return call_options;
}

///////////////////////////////////////////////////////////////////////////////
function getsetOptions()
{
  setOptions(getOptions());
}

///////////////////////////////////////////////////////////////////////////////
window.onload = function() {
  console = new Console();

  video_player_1 = document.getElementById('video_player_1');

}

///////////////////////////////////////////////////////////////////////////////
window.onbeforeunload = function() {
  ws.close();
}

///////////////////////////////////////////////////////////////////////////////
// Management of Client <=> Server WebSocket connections
///////////////////////////////////////////////////////////////////////////////
function sendMessage(message) {
  var jsonMessage = JSON.stringify(message);
  
  console.log('Sending message to Server: ' + jsonMessage);
  
  ws.send(jsonMessage);
}

///////////////////////////////////////////////////////////////////////////////
ws.onmessage = function(message) {
  var parsedMessage = JSON.parse(message.data);
  
  console.info('Received message: ' + message.data);

  switch (parsedMessage.id) 
  {
    case 'start_call_answer':
      startCallAnswer(parsedMessage);
      break;
    
    case 'stopCommunication':
      disposeWebRtcPeer();
      break;
    
    case 'iceCandidate':
      webRtcPeer.addIceCandidate(parsedMessage.candidate)
      break;
    
    case 'sessionInfoArray':
      processSessionInfoArray(parsedMessage.sessionInfoArray);
      break;

    case 'fileInfoArray':
      processFileInfoArray(parsedMessage.fileInfoArray);
      break;

    case 'recordingStateChange':
      processRecordingStateChange(parsedMessage.state);
      break;

    case 'userMessage':
      processUserMessage(parsedMessage.userMessage);
      break;

    case 'seekStreamResponse':
      // TODO as required
      break;

    case 'streamInfo':
      processStreamInfo(parsedMessage);
      break;
      
    default:
      console.error('Unrecognized message', parsedMessage);

  } //switch (parsedMessage.id)
}

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
function onError(error) {
  console.log("onError", error);

  // TODO we should ??? stopCall and dispose WebRtcPeer ???

  // TODO raise UI alert as required !!!
}

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
function startCall() {

  if ((logged_in_user == null) || (logged_in_user.length == 0)) {
    alert("Please login first !");
    return;
  }

  /////////////////////////////////////
  // work out what sort of call we want to make
  var call_options = getOptions();

  var bPresenter  = false; // call_options.mode_selection    == "viewer" || "presenter"
  var bScreencast = false; // call_options.capture_selection == "webcam" || "screen"

  if (call_options.mode_selection == "viewer") {

      if ((call_options.presenter == "") || (call_options.presentation == "") || (call_options.replay_selection == "")) {
        alert("Please select a presentation or file !");
        return;
      }

      if (call_options.replay_selection == "live") {
        $('#seek_controls').hide();
      }
      else if (call_options.replay_selection == "recording") {
        $('#seek_controls').show();
      }
      else if (call_options.replay_selection == "recorded") {
        $('#seek_controls').show();
      }
      else {
        // Why are we here ??? Unknown call_options.replay_selection !!!        
      }
      
  }
  else if (call_options.mode_selection == "presenter") {
    if ((call_options.audio !== true) && (call_options.video !== true))
    {
        alert("You must select at least one or audio or video stream to present !");
        return;
    }

    bPresenter = true;


    // TODO call_options.presenter    ??? presenter_username
    // TODO call_options.presentation ??? presentation_name

    if (call_options.capture_selection == "screen")
    {
      if (call_options.video !== true)
      {
          alert("Screencasting without video is not particularly useful !");
          return;
      }

      bScreencast = true;
    }

    $('#seek_controls').hide();
  }
  else {
    // Why are we here ??? Unknown options.mode_selection !!!
    alert("Unknown options.mode_selection !!!");
    return;
  }

  /////////////////////////////////////
  // setup the appropriate constraints
  var constraints = null; 
  var options     = null; 
    
  if (bPresenter) {
    
    if (bScreencast) {
      if (window.chrome && window.chrome.webstore) { // Chrome 1+
        constraints = {
          audio: false,
          video: {
            frameRate: { min: 1, ideal: 15, max: 30 },
            mandatory: {
              chromeMediaSource: 'screen', // 'desktop'
              chromeMediaSourceId: 'TBD',
              width: { min: 320, ideal: 1920, max: 4096 },
              height: { min: 240, ideal: 1080, max: 2160 }
            }
          },

          mandatory: {
            OfferToReceiveAudio: false,
            OfferToReceiveVideo: false
          }
        };
      } 
      else if (typeof InstallTrigger !== 'undefined') { // Firefox 1.0+
        constraints = {
          audio: call_options.audio, // only working in firefox
          video: {
            frameRate: { min: 1, ideal: 15, max: 30 },
            mozMediaSource: "screen", // 'window ' || 'screen'
            mediaSource: "screen", // 'window ' || 'screen'
            mandatory: {
              width: { min: 320, ideal: 1920, max: 4096 },
              height: { min: 240, ideal: 1080, max: 2160 }
            }
          },

          mandatory: {
            OfferToReceiveAudio: false,
            OfferToReceiveVideo: false
          }
        };
      } 
      else { // other browser types
        constraints = {
          audio: call_options.audio,
          video: {
            frameRate: { min: 1, ideal: 15, max: 30 },
            mozMediaSource: "screen", // 'window ' || 'screen'
            mediaSource: "screen", // 'window ' || 'screen'
            mandatory: {
              chromeMediaSource: 'screen', // 'desktop'
              chromeMediaSourceId: 'TBD',
              width: { min: 320, ideal: 1920, max: 4096 },
              height: { min: 240, ideal: 1080, max: 2160 }
            }
          },

          mandatory: {
            OfferToReceiveAudio: false,
            OfferToReceiveVideo: false
          }
        };

        console.log("POTENTIALLY UNSUPPORTED BROWSER TYPE !!!");
      }

      options = {
        localVideo      : video_player_1,
        remoteVideo     : null,
        onicecandidate  : onIceCandidate,
        mediaConstraints: constraints,
        sendSource      : 'screen'
      }
    } 
    else {
      constraints = {
        audio: call_options.audio,
        video: call_options.video,

        mandatory: {
          OfferToReceiveAudio: false,
          OfferToReceiveVideo: false
        }
      }

      options = {
        localVideo      : video_player_1,
        remoteVideo     : null,
        onicecandidate  : onIceCandidate,
        mediaConstraints: constraints,
        sendSource      : 'webcam'
      }
    }

  }
  else {
    constraints = {
      audio: true,
      video: true,

      mandatory: {
        OfferToReceiveAudio: false,
        OfferToReceiveVideo: false
      }
    }

    options = {
      localVideo      : null,
      remoteVideo     : video_player_1,
      onicecandidate  : onIceCandidate,
      mediaConstraints: constraints
    }
  }

  /////////////////////////////////////
  // create the client endpoint and initiate the call process
  if (!webRtcPeer) {
    showSpinner([video_player_1]);

    if (bPresenter) {
      webRtcPeer = new kurentoUtils.WebRtcPeer.WebRtcPeerSendonly(options, function(error) {
        if (error) { return onError(error); }
        webRtcPeer.generateOffer(onOffer);
      });
    }
    else {
      webRtcPeer = new kurentoUtils.WebRtcPeer.WebRtcPeerRecvonly(options, function(error) {
        if (error) { return onError(error); }
        webRtcPeer.generateOffer(onOffer);
      });
    }

    $("#collapse-call-section-icon").attr('style', 'color: green');

  } // if (!webRtcPeer) 
}

///////////////////////////////////////////////////////////////////////////////
function onOffer(error, offerSdp) {
  if (error) return onError(error);

  var call_options = getOptions(); // TODO relying on the user to not change these at the moment !!!

  // call_options.presenter    ??? presenter_username
  // call_options.presentation ??? presentation_name
  // call_options.mode_selection
  // call_options.stream_selection
  // call_options.audio              
  // call_options.video
  // call_options.recording_selection
  // call_options.replay_selection

  var message = { id: 'start_call', call_options: call_options, sdpOffer: offerSdp };
  
  sendMessage(message);
}

///////////////////////////////////////////////////////////////////////////////
function startCallAnswer(message) {
  if (message.response != 'accepted') {
    var errorMsg = message.message ? message.message : 'Unknown error';
    console.warn('Call not accepted for the following reason: ' + errorMsg);
    
    disposeWebRtcPeer();
  } 
  else {
    webRtcPeer.processAnswer(message.sdpAnswer);
  }
}

///////////////////////////////////////////////////////////////////////////////
function stopCall() {
  if (webRtcPeer) {
    var message = { id: 'stop_call' }
    
	  sendMessage(message);
    
	  disposeWebRtcPeer();

    $("#collapse-call-section-icon").attr('style', 'color:');
  }
}

///////////////////////////////////////////////////////////////////////////////
// helper functions
function onIceCandidate(candidate) {
  //console.log('Local candidate' + JSON.stringify(candidate));

  var message = { id: 'onIceCandidate', candidate: candidate }
  
  sendMessage(message);
}

///////////////////////////////////////////////////////////////////////////////
function disposeWebRtcPeer() {
  hideSpinner([video_player_1]);

  $('#recording_indicator').hide();
  $('#seek_controls').hide();

  $('#position').val('--:--:--');
  $('#duration').val('--:--:--');
  
  if (webRtcPeer) {
    webRtcPeer.dispose();
    webRtcPeer = null;
  }
}

///////////////////////////////////////////////////////////////////////////////
function showSpinner(video_elements) {
  for (var i = 0; i < video_elements.length; i++) {
    video_elements[i].poster = './img/transparent-1px.png';
    video_elements[i].style.background = 'center transparent url("./img/spinner.gif") no-repeat';
  }
}

///////////////////////////////////////////////////////////////////////////////
function hideSpinner(video_elements) {
  for (var i = 0; i < video_elements.length; i++) {
    video_elements[i].src = '';
    video_elements[i].poster = './img/webrtc.png';
    video_elements[i].style.background = '';
  }
}

///////////////////////////////////////////////////////////////////////////////
//  Lightbox utility (to display media pipeline image in a modal dialog)
$(document).delegate('*[data-toggle="lightbox"]', 'click', function(event) {
  event.preventDefault();
  $(this).ekkoLightbox();
});

///////////////////////////////////////////////////////////////////////////////
// TEMP
function loginUser() {
  logged_in_user = $("#logged_in_user").val();

  var message = { id: 'userLogin', logged_in_user: logged_in_user };

  sendMessage(message);
}

///////////////////////////////////////////////////////////////////////////////
// TEMP
function logoutUser() {
  $("#logged_in_user").val('');

  var message = { id: 'userLogout' };

  sendMessage(message);
}

///////////////////////////////////////////////////////////////////////////////
function onUserMessageKeyEvent(event)
{
  if (event.keyCode == 13) {
    if (event.shiftKey == false) {
      sendUserMessage();
    }
    
    return false;
  }
}

///////////////////////////////////////////////////////////////////////////////
function scanFileInfoArray() {

  var message = { id: 'scanFileInfoArray' };

  sendMessage(message);
}

///////////////////////////////////////////////////////////////////////////////
function sendUserMessage()
{
  var text = $("#message").val();

  var message = { id: 'userMessage', userMessage: { to: [], from: logged_in_user, channel: 'general',text: text } };

  sendMessage(message);

   $("#message").val("");
}

///////////////////////////////////////////////////////////////////////////////
function processUserMessage(userMessage)
{
  var formatedMessage = userMessage.from + " - " + userMessage.text; 

  console.log('userMessage ', formatedMessage);

  //var messages = $("#messages");
  //messages.append(formatedMessage);

// get reference to select element
  var sel = document.getElementById('messages');

  // create new option element
  var opt = document.createElement('option');

  // create text node to add to option element (opt)
  opt.appendChild( document.createTextNode(formatedMessage) );

  // set value property of opt
  opt.value = 'option value'; 

  // add opt to end of select box (sel)
  sel.appendChild(opt);   
}

///////////////////////////////////////////////////////////////////////////////
function togglePause() {
  var text = $("#pause").text();

	if (text.includes("Pause")) {
		$("#pause").text(" Resume");
    $("#pause").attr('class', 'btn btn-warning glyphicon glyphicon-play');

    var message = { id: 'pauseStream'};
  
    sendMessage(message);
	} 
  else {
		$("#pause").text(" Pause");
	  $("#pause").attr('class', 'btn btn-warning glyphicon glyphicon-pause');

    var message = { id: 'resumeStream'};
  
    sendMessage(message);
  }
}

///////////////////////////////////////////////////////////////////////////////
function seekStream(offset) {

  var message = { id: 'seekStream', offset: offset };
  
  sendMessage(message);
}

///////////////////////////////////////////////////////////////////////////////
function setVideoPlayerSize(width, height)
{
  $('#video_player_1').width(width).height(height);
  
  document.body.style.zoom = 1.0000001;
  
  setTimeout(function() { document.body.style.zoom = 1; }, 50); 
}

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
function processSessionInfoArray(parsedMessage)
{
  //console.log(parsedMessage);

  sessionInfoArray = parsedMessage;

  /////////////////////////////////////
  // phase 1 build the lists of participants, presenters and viewers

  // base tree data structure
  var tree_data = [
    {
      text: "SESSIONS", 
        nodes: []
    },
    {
      text: "PRESENTATIONS",
        nodes: []
    },
    {
      text: "PARTICIPANTS",
        nodes: []
    }
  ];

  /////////////////////////////////////
  tree_data[0].nodes.push( { text: 'session1' } );

  var participants = [];

  for (var i = 0; i < sessionInfoArray.length; i++) {
    var sessionInfo = sessionInfoArray[i];

    // everyone is a particpant
    if (sessionInfo.logged_in_user != null) {
      var participant = { text: sessionInfo.logged_in_user };
      
      var bFound = false;
      
      for(var p = 0; (!bFound) && (p < participants.length); p++) {
          if (participants[p].text == participant.text) {
              bFound = true;
          }
      }      
      
      if (!bFound) {
        participants.push(participant);
      }
    }

    // are they presenting
    if (sessionInfo.call_options) {
      if (sessionInfo.call_options.mode_selection == "presenter") {

        var child_text = sessionInfo.call_options.presentation + " by " + sessionInfo.call_options.presenter + " - " + sessionInfo.call_options.capture_selection; 

        var live_child      = { text: child_text + " (live)", nodes: [] };
        var recording_child = { text: child_text + " (recording)", nodes: [] };

        tree_data[1].nodes.push(live_child);

        if (sessionInfoArray[i].call_options.recording_selection != "none")
        {
          tree_data[1].nodes.push(recording_child);
        }

        /////////////////////////////////////
        // who is watching them ?
        var live_viewers = [];
        var recording_viewers = [];

        for (var v = 0; v < sessionInfoArray.length; v++) {
          var sessionInfo2 = sessionInfoArray[v];

          // are they viewing
          if (sessionInfo2.call_options) {
            if (sessionInfo2.call_options.mode_selection == "viewer") {
              // Are they watching this ?
              if ((sessionInfo2.call_options.presentation == sessionInfo.call_options.presentation) &&
                  (sessionInfo2.call_options.presenter == sessionInfo.call_options.presenter) &&
                  (sessionInfo2.call_options.capture_selection == sessionInfo.call_options.capture_selection)) {

                  if (sessionInfo2.call_options.replay_selection == "live") {
                    live_viewers.push({ text: sessionInfo2.logged_in_user } );
                  }
                  else if (sessionInfo2.call_options.replay_selection == "recording") {
                    recording_viewers.push({ text: sessionInfo2.logged_in_user } );
                  }
              }

            } // if (sessionInfo2.call_options.mode_selection == "viewer") 
          } // if (sessionInfo2.call_options) {
        } // for (var v = 0; v < sessionInfoArray.length; v++)

        live_child.nodes = live_viewers.sort(function(a,b) { return (a.text > b.text) ? 1 : ((b.text > a.text) ? -1 : 0); } ); 
        recording_child.nodes = recording_viewers.sort(function(a,b) { return (a.text > b.text) ? 1 : ((b.text > a.text) ? -1 : 0); } );

      } // if (sessionInfo.call_options.mode_selection == "presenter") 
    } // if (sessionInfo.call_options) 
  } // for (var i = 0; i < sessionInfoArray.length; i++) 

  tree_data[2].nodes = participants.sort(function(a,b) { return (a.text > b.text) ? 1 : ((b.text > a.text) ? -1 : 0); } ); 

  /////////////////////////////////////
  $('#participants').treeview({data: tree_data});

  /////////////////////////////////////
  // phase 2 build the list of available presentations
  var select = $('#presentation_selection')[0];
  
  // TODO retrieve current selection
  // TODO alert( select.options[ select.selectedIndex ].value )

  while (select.firstChild) {
      select.removeChild(select.firstChild);
  }

  select.options.add(new Option("a presentation", ""));

  for (var i = 0; i < sessionInfoArray.length; i++) {
    var sessionInfo = sessionInfoArray[i];

    if (sessionInfo.call_options) {
      if (sessionInfo.call_options.mode_selection == "presenter") {

        var text = sessionInfo.call_options.presentation + " by " + sessionInfo.call_options.presenter + " " + sessionInfo.call_options.capture_selection; 

        sessionInfo.call_options.replay_selection = 'live';

        var data = JSON.stringify(sessionInfo);

        select.options.add(new Option(text + " (live)", data));

        if (sessionInfoArray[i].call_options.recording_selection != "none")
        {
          sessionInfo.call_options.replay_selection = 'recording';
          
          var data = JSON.stringify(sessionInfo);

          select.options.add(new Option(text + " (recording)", data));
        }
      }
    }
  }

  // TODO reselect current selection if we had one
}

///////////////////////////////////////////////////////////////////////////////
function processFileInfoArray(parsedMessage)
{
  //console.log(parsedMessage);

  fileInfoArray = parsedMessage.sort(function(a,b) {
     var asort = a.file.toLowerCase();
     var bsort = b.file.toLowerCase();
     
     return (asort > bsort) ? 1 : ((bsort > asort) ? -1 : 0); 
    });

  /////////////////////////////////////
  // phase 1 build the list of available files
  var select = $('#file_selection')[0];
  
  // TODO retrieve current selection
  // TODO alert( select.options[ select.selectedIndex ].value )

  while (select.firstChild) {
      select.removeChild(select.firstChild);
  }

  select.options.add(new Option(' a file', ''));

  for (var i = 0; i < fileInfoArray.length; i++) {
    var fileInfo = fileInfoArray[i];

    var text         = fileInfo.file;
    var call_options = { presentation: '', presenter: '', capture_selection: '', replay_selectiom: '' };

    call_options.presentation      = fileInfo.dir + fileInfo.file;
    call_options.presenter         = 'TODO as required';
    call_options.capture_selection = 'TODO as required'; 

    call_options.replay_selection  = 'recorded';

    var sessionInfo = { call_options: call_options };

    var data = JSON.stringify(sessionInfo);

    select.options.add(new Option(text, data));
  }

  // TODO reselect current selection if we had one
}

///////////////////////////////////////////////////////////////////////////////
function processRecordingStateChange(state) {

  if (state) {
    $('#recording_indicator').show();
    $("#collapse-call-section-icon").attr('style', 'color: red');
  }
  else { 
    $('#recording_indicator').hide(); 
    $("#collapse-call-section-icon").attr('style', 'color:');
  }
}

///////////////////////////////////////////////////////////////////////////////
function processStreamInfo(parsedMessage) {

  console.log('position    ' + parsedMessage.position + ' ' + SecondsToHHMMSS((parsedMessage.position/1000))); 
  console.log('duration    ' + parsedMessage.duration + ' ' + SecondsToHHMMSS((parsedMessage.duration/1000))); 
  console.log('isSeekable  ' + parsedMessage.isSeekable); 
  console.log('seekableInit' + parsedMessage.seekableInit); 
  console.log('seekableEnd ' + parsedMessage.seekableEnd);
 
  var position = SecondsToHHMMSS((parsedMessage.position/1000));
  var duration = SecondsToHHMMSS((parsedMessage.duration/1000));

  $('#position').text(position);
  $('#duration').text(duration);
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
///////////////////////////////////////////////////////////////////////////////

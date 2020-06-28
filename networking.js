const networking = (function () {
	const STUN_SERVERS = [
		{url: 'stun:stun.l.google.com:19302'}
	];
	const TURN_SERVERS = [
		{
			url: 'turn:numb.viagenie.ca',
			credential: 'muazkh',
			username: 'webrtc@live.com'
		}, {
     url: 'turn:relay.backups.cz',
     credential: 'webrtc',
     username: 'webrtc'
	 }, {
     url: 'turn:relay.backups.cz?transport=tcp',
     credential: 'webrtc',
     username: 'webrtc'
	 }
	];
	const signalingServer = 'http://slime.glenwatson.me';
	let localConnection = null,
		dataChannel = null,
		/**
		 * NOT_CALLED: the library hasn't been called yet
		 * INITIALIZING: the library hasn't been initialized yet
		 * OPEN: the datachannel is ready to send/recieve
		 * CLOSED: the datachannel has been closed
		 */
		internalState = 'NOT_CALLED',
		readyPromiseResolver = null,
		clientId = null,
		usersReceiveMessageCallback = () => {};

	/**
	 * Hosts a new connection
	 * @param cId The client's ID. Must be unique per user.
	 * @param newMessageCallback function called whenever there is a new message received
	 */
	function hostConnection(cId, newMessageCallback) {
		const readyPromise = init(cId, newMessageCallback);
		//TODO make this return a promise?
		createOfferAndPollForAnswer();
		return readyPromise;
	}
	/**
	 * Join an existing connection
	 * @param cId The client's ID. Must be unique per user.
	 * @param newMessageCallback function called whenever there is a new message received
	 */
	function joinAHost(cId, newMessageCallback) {
		const readyPromise = init(cId, newMessageCallback);
		joinExisting();
		return readyPromise;
	}
	/**
	 * Initialize a connection
	 * @param cId The client's ID. Must be unique per user.
	 * @param newMessageCallback function called whenever there is a new message received
	 */
	function init(cId, newMessageCallback) {
		if (internalState == 'INITIALIZING') {
			throw new Error('Still initializing a connection', internalState);
		}
		if (internalState == 'OPEN') {
			throw new Error('A connection is still open. Call disconnect() first', internalState);
		}
		internalState = 'INITIALIZING';
		clientId = cId;
		usersReceiveMessageCallback = newMessageCallback;
		return new Promise(resolve => {
			//Capture resolve function for later use
			readyPromiseResolver = resolve;
		});
	}
	/**
	 * Initializes the localConnection with defaults
	 */
	function newLocalRTCPeerConnection() {
		localConnection = new RTCPeerConnection({iceServers: STUN_SERVERS.concat(TURN_SERVERS)});
		// set up ICE candidates
		//onicecandidate() is automatically called by the browser with candidates once the localConnection is started
		localConnection.onicecandidate = function(event) {
			console.log('local onicecandidate', event);
			if (event.candidate) {
				sendToSignalingServer({type:'ice_candidate', candidate: event.candidate});
			}
		};
	}
	function createOfferAndPollForAnswer() {
		// Set up the local peer
		newLocalRTCPeerConnection();
		//https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/createDataChannel
		//Setting "negotiated: false" (or leaving it out) will automatically trigger the RTCPeerConnection to handle the negotiations for you, causing the remote peer to create a data channel and linking the two together across the network.
		const dataChannelOptions = {
			ordered: true, //If the data channel should guarantee order or not
			//maxPacketLifeTime: 3000, //The maximum time to try and retransmit a failed message in milliseconds
			//maxRetransmits: 2, //The maximum number of times to try and retransmit a failed message
			//protocol: 'slime-soccer-protocol', //Allows a subprotocol to be used which provides meta information towards the application
			//negotiated: false, //If set to true, it removes the automatic setting up of a data channel on the other peer, meaning that you are provided your own way to create a data channel with the same id on the other side
			//id: '???', //Allows you to provide your own ID for the channel (can only be used in combination with negotiated set to true)
		};
		dataChannel = localConnection.createDataChannel("dataChannel", dataChannelOptions);
		dataChannel.onmessage = handleReceiveMessage
		//update the UI on connect/disconnect
		dataChannel.onopen = handleDataChannelStatusChange;
		dataChannel.onclose = handleDataChannelStatusChange;

		//https://www.html5rocks.com/en/tutorials/webrtc/infrastructure/
		//https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Connectivity
		//Start the connection attempt by hosting
		localConnection.createOffer() //3. create an SDP (Session Description Protocol) blob describing the connection we want to make
			.then(offer => {
				localConnection.setLocalDescription(offer); //4. configure the local end of the connection.
				//TODO //5. ask STUN servers to generate the ice candidates
				sendToSignalingServer(offer); //6. uses the signaling server to transmit the offer.
				// start polling for an answer
				var cancelFunction = startPollingSignalingServer(clientId, onNewSignalingMessageHandler(answerMessage => {
					localConnection.setRemoteDescription(new RTCSessionDescription(answerMessage)) //13. Call setRemoteDescription() to set the answer as the remote description for its end of the call. It now knows the configuration of both peers.
						.then(() => console.log('host is connected'))
						//.then(() => cancelFunction()) // stop polling for message from the signaling server
						.catch((e) => console.error(e));
				}));
			});

	}
	function joinExisting() {
		// Set up the local peer
		newLocalRTCPeerConnection();
		localConnection.ondatachannel = receiveChannelCallback;

		// start polling for an offer
		var cancelFunction = startPollingSignalingServer(clientId, onNewSignalingMessageHandler(offerMessage => {
			localConnection.setRemoteDescription(new RTCSessionDescription(offerMessage)) //7. Receive the offer and calls RTCPeerConnection.setRemoteDescription() to record it as the remote description (the description of the host)
				.then(() => localConnection.createAnswer()) //8-9. Create an answer by calling RTCPeerConnection.createAnswer()
				.then((answer) => {
					localConnection.setLocalDescription(answer); //10. Call RTCPeerConnection.setLocalDescription(), passing in the created answer, to set the answer as its local description. The recipient now knows the configuration of both ends of the connection.
					sendToSignalingServer(answer); //11. Use the signaling server to send the answer to the caller.
				})
				.then(() => console.log('joiner is connected'))
				// TODO Do we still need to continue polling (e.g. for ICE) after an offer is complete?
				//.then(() => cancelFunction()) // stop polling for message from the signaling server
				.catch((e) => console.error(e));
		}));
	}
	/**
	 * Common code for handling a new signaling message
	 * @param sdpCallback callback for non-common SDP messages.
	 */
	function onNewSignalingMessageHandler(sdpCallback) {
		return function(newMessage) {
			// Both host and client want to call addIceCandidate() when offered an ICE candidate
			if (newMessage.type === 'ice_candidate') {
				localConnection.addIceCandidate(new RTCIceCandidate(newMessage.candidate));
			// The only two SDP types known are 'offer 'and 'answer'.
			} else if (newMessage.type === 'offer' || newMessage.type === 'answer') {
				sdpCallback(newMessage);
			} else {
				console.error("I didn't expect this message type", newMessage.type);
			}
		}
	}
	/**
	 * @param clientId The unique client ID for this browser session
	 * @param messageCallback Called for each message received
	 * @return A function the caller uses to stop polling
	 */
	function startPollingSignalingServer(clientId, messageCallback) {
		let delay = 1000;
		let cancelled = false;
		function doPoll() {
			console.log('polling with delay', delay);
			setTimeout(() => {
				makeAjaxCall(
					signalingServer + '/serverGet.php?unique=' + clientId,
					'POST'
				).then((response) => {
					if (response) {
						const json = JSON.parse(response);
						if (json.retry) {
							//server controlled retry delay
							delay = json.retry;
						} else {
							console.log('Got an answer!');
							messageCallback(json);
							delay = 0;
						}
					}
					if (!cancelled) {
						doPoll();
					}
				}).catch((e) => console.error(e));
			}, delay);
		};
		doPoll();
		return () => {cancelled = true;};
	}
	/**
	 * Enqueue data to the signaling server
	 * @param jsonObj JSON object to enqueue
	 * @return Promise with the results
	 */
	function sendToSignalingServer(jsonObj) {
		return makeAjaxCall(
			signalingServer + '/serverPost.php?unique=' + clientId,
			'POST',
			jsonObj ? JSON.stringify(jsonObj) : undefined
		);
	}
	/**
	 * Make an XHR request to an endpoint.
	 * @param url endpoint to call
	 * @param method HTTP method to use. (GET, POST, PUT, etc)
	 * @param data JSON object to enqueue
	 * @return Promise with the results
	 */
	function makeAjaxCall(url, method, data) {
		const xhr = new XMLHttpRequest();
		const promise = new Promise((resolve, reject) => {
			xhr.onload = function() {
				if (xhr.status === 200) {
					// If successful, resolve the promise by passing back the xhr response
					resolve(xhr.response);
				} else {
					// If it fails, reject the promise with a error message
					reject(Error('Image did not load successfully; error code:' + xhr.statusText));
				}
			};
			xhr.onerror = function() {
				// Also deal with the case when the entire request fails to begin with
				// This is probably a network error, so reject the promise with an appropriate message
				reject(Error('There was a network error.'));
			};
		});
		xhr.open(method, url, true);
		xhr.send(data);
		return promise;
	}
	/**
	 * Handler for when the joining party gets a channel
	 */
	function receiveChannelCallback(event) {
		console.log('remote ondatachannel', event);
		dataChannel = event.channel;
		dataChannel.onmessage = handleReceiveMessage;
		dataChannel.onopen = handleDataChannelStatusChange;
		dataChannel.onclose = handleDataChannelStatusChange;
	}
	/**
	 * Handler for when the datachannel is ready
	 */
	function handleDataChannelStatusChange(event) {
		console.log('local handleDataChannelStatusChange', event);
		if (!dataChannel) {
			return;
		}
		var state = dataChannel.readyState;

		if (state === "open") { //finished establishing the link between the two peers
			internalState = 'OPEN';
			readyPromiseResolver();
		} else { //"closed"
			internalState = 'CLOSED';
		}
	}
	/**
	 * Disconnects from the peer
	 */
	function disconnect() {
		if (internalState != 'OPEN') {
			throw Error('Can not disconnect from non-open connection', internalState);
		}
		console.log('disconnecting');
		// Close the RTCDataChannels if they're open.
		dataChannel.close();
		// Close the RTCPeerConnections
		localConnection.close();
		dataChannel = null;
		localConnection = null;
	}
	/**
	 * Sends a message
	 * @param jsObject the javascript object to send
	 */
	function sendJavascriptObject(jsObject) {
		if (internalState != 'OPEN') {
			throw Error('Can not send message until connection is open', internalState);
		}
		console.log('sending message (send)', jsObject);
		dataChannel.send(JSON.stringify(jsObject));
	}
	/**
	 * Handler for when a message is received
	 */
	function handleReceiveMessage(event) {
		console.log('recieved message (onmessage)', event);
		usersReceiveMessageCallback(JSON.parse(event.data));
	}
	return {
		hostConnection,
		joinAHost,
		sendJavascriptObject,
		disconnect
	};
})();
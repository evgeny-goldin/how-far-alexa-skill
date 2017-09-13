// Allow updating user's default origin
// Swap origin and destination for "To" question
// Pronounce both destination and updated destination ?

'use strict';

const Alexa = require('alexa-sdk');
const AWS = require('aws-sdk');
AWS.config.update({region: 'us-east-1'});
const https = require('https');
const querystring = require('querystring');

const cloudwatch = new AWS.CloudWatch({apiVersion: '2010-08-01'});
const sns = new AWS.SNS({apiVersion: '2010-03-31'});

const APP_ID = 'amzn1.ask.skill.77f9ca28-bcb2-453c-9795-69039d37c8fe';
const ERRORS_SNS_TOPIC = 'arn:aws:sns:us-east-1:315557731078:HowFarErrors';

const ALEXA_ENDPOINT = 'api.amazonalexa.com';
const MAPS_ENDPOINT = 'maps.googleapis.com';
const ALEXA_ENDPOINT_TIMEOUT = 2000;
const MAPS_ENDPOINT_TIMEOUT = 4000;
const ALEXA_ENDPOINT_RETRIES = 3;
const MAPS_ENDPOINT_RETRIES = 3;

const waitingForInput = 'Where would you like to go?';
const waitingForInputDelayed = ' <break time="0.5s"/> ' + waitingForInput;
const drivingHoursPerDay = 8;
const defaultDestination = 'Seattle, WA';
const defaultOrigin = 'Seattle, WA';
const CloudWatchNamespace = 'HowFarLambda';

const samplePhrases = ['Yellowstone Park', 'Vienna from Munich', 'Las Vegas from LAX'];

const welcomeMessage = 'Welcome to "How Far" Alexa skill <break time="0.05s"/> telling how far your destination is in driving hours. ' + 
                       'You can say <break time="0.25s"/> ' + samplePhrases[0] + ', ' +  
                       '<break time="0.4s"/> ' + samplePhrases[1] + ' <break time="0.3s"/>' + 
                       'or <break time="0.3s"/> ' + samplePhrases[2] + '.';  
                      
const welcomeSpeechOutput = welcomeMessage + waitingForInputDelayed;
                      
const welcomeCardContent = samplePhrases.join('\n') + '\n\n' + waitingForInput;

const log = console.log;

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

/**
 * Logs incoming event, user and device Id
 */ 
function logEvent(self) {
    if (self.event) { log(self.event); }
    log("User: " + getUserId(self));
    log("Device: " + getDeviceId(self));
}

/**
 * Determines if the String provided is US postal code
 */ 
function isPostalCode(s) {
    // US postal codes only so far, other countries may use letter as well
    return (s.match(/^\d+$/) !== null);
}

/**
 * Returns a random number form 0 (inclusive) to N (exclusive)
 */ 
function randomNumber(topNumber) {
    return Math.floor(Math.random() * topNumber);
}

/**
 * Returns array's random element
 */ 
function random(array) {
    return(array[ randomNumber(array.length) ]);
}

/**
 * Returns random compliance report 
 */ 
function complyResponse() {
    return random(['Sure!', 'OK!', 'Done!', 'Got it', 'Done deal']);
}

/**
 * Returns slot's value or a default value if slot is not available or its value is undefined
 */ 
function slotValue(slot, defaultValue) {
    return (slot ? (slot.value || defaultValue) : defaultValue);
}

/**
 * Clears all SSML tags from the response 
 */ 
function clearTags(s) {
    return (s || '').replace(/<[^>]+>/g, '');
}

/**
 * Wraps a String provided in <say-as interpret-as="address">
 */ 
function sayAsAddress(s) {
    return '<say-as interpret-as="address">' + s + '</say-as>';
}

/**
 * Retrieves a user Id from the current request or empty String if unavailable
 */ 
function getUserId(self) {
    return self.event.context ? self.event.context.System.user.userId : '';
}

/**
 * Retrieves a device Id from the current request or empty String if unavailable
 */ 
function getDeviceId(self) {
    return self.event.context ? self.event.context.System.device.deviceId : '';
}

/**
 * Retrieves a default origin, either device postal code (if enabled) or a predefined one
 */ 
function getDefaultOrigin(self) {
    return (self.attributes.defaultOrigin || defaultOrigin);
}

/**
 * Determines if array provided has any data (not empty)
 */ 
function hasData(array){
    return (array && (array.length > 0));
}

/**
 * :tellWithCard wrapper
 */ 
function tellWithCard(self, speechOutput, cardTitle, cardContent) {
    cardTitle = clearTags(cardTitle);
    cardContent = clearTags(cardContent || speechOutput);
    log("tellWithCard: [" + clearTags(speechOutput) + "][" + cardTitle + "][" + cardContent + "]");
    self.emit(':tellWithCard', speechOutput, cardTitle, cardContent); 
}

/**
 * :askWithCard wrapper
 */ 
function askWithCard(self, speechOutput, repromptSpeech, cardTitle, cardContent) {
    cardTitle = clearTags(cardTitle);
    cardContent = clearTags(cardContent || speechOutput);
    log("askWithCard: [" + clearTags(speechOutput) + "][" + cardTitle + "][" + cardContent + "]");
    self.emit(':askWithCard', speechOutput, repromptSpeech, cardTitle, cardContent); 
}

/**
 * Greets the user and provides the intro message
 */ 
function tellWelcomeMessage(self) {
    const speechOutput = welcomeMessage + 
                         " <break time='0.3s'/> Your location is set to " + sayAsAddress(getDefaultOrigin(self)) + ". " + 
                         waitingForInputDelayed; 
    askWithCard(self, speechOutput, waitingForInput, waitingForInput, welcomeCardContent);
}

/**
 * Logs the error specified
 */ 
function logError(error, errorDescription) {
    console.error('++++++++++ [' + errorDescription + '] ++++++++++');
    console.error(error || errorDescription); 
    console.error('++++++++++ [' + errorDescription + '] ++++++++++');
}

/**
 * Handles an error thrown - logs it, publishes to SNS and emits a CloudWatch metric
 */ 
function handleError(error, errorDescription, errorType) {
    logError(error, errorDescription);
    publishSNSMessage(error.stack || errorDescription, 'HowFar - error logged', ERRORS_SNS_TOPIC);
    if (errorType) {
        emitCloudWatchMetric('LoggedError', 'Count', 1, 'ErrorType', errorType);
    }
}

/**
 * Updates session metrics - length in seconds and number of utternaces. 
 * If session has ended - emits corresponding CloudWatch metrics.
 */ 
function updateSessionMetrics(self, isUtterance, sessionEnded) {
    if (self.attributes.sessionStarted) {
        // Session has already started
        if (isUtterance){ 
            self.attributes.utterances += 1; 
        }
    } else {
        // New session
        self.attributes.sessionStarted = Date.now();
        self.attributes.utterances = isUtterance ? 1 : 0;
    }
    
    const sessionLengthInSeconds = ((Date.now() - self.attributes.sessionStarted) / 1000);
    
    if (sessionEnded) {
        log('Session ended: ' + self.attributes.utterances + ' utterances, lasted ' + sessionLengthInSeconds + ' seconds');
        emitCloudWatchMetric('SessionUtterances', 'Count', self.attributes.utterances);
        emitCloudWatchMetric('SessionLength', 'Seconds', sessionLengthInSeconds);
    } else {
        log('Session metrics: ' + self.attributes.utterances + ' utterances, started ' + sessionLengthInSeconds + ' seconds ago');
    }
}

/**
 * Publishes a message provided to SNS topic specified.
 */ 
function publishSNSMessage(message, subject, topicName) {
    log('Publishing SNS message [' + message + '], subject [' + subject + '] to [' + topicName + ']'); 
    // http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/SNS.html#publish-property
    sns.publish({ Message: '===============\n' + message + '\n===============', 
                  Subject: subject, 
                  TopicArn: topicName }, (error) => {
        if (error) { 
            logError(error, 'Failed to publish SNS message [' + message + '], subject [' + subject + '] to [' + topicName + ']'); 
        }
    });
}

/**
 * Emits CloudWatch metric provided.
 */ 
function emitCloudWatchMetric(name, unit, value, dimensionName, dimensionValue) {
    // http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/CloudWatch.html#putMetricData-property
    log("Emitting CloudWatch " + CloudWatchNamespace + " metric [" + name + "] = [" + value + "] (" + unit + 
        (dimensionName ? ", " + dimensionName + " = " + dimensionValue : '') + ")");
    const params = { 
        Namespace: CloudWatchNamespace, 
        MetricData: [{ 
           MetricName: name, 
           Dimensions: dimensionName ? [{ Name: dimensionName, Value: dimensionValue }] : [],
           Unit: unit, 
           Value: parseFloat(value)
        }]
    };
    
    cloudwatch.putMetricData(params, (error) => { 
        if (error) { 
            // *DO NOT* specify an error type or it'll attempt to emit another metric
            handleError(error, 'Failed emitting CloudWatch metric [' + name + ']'); 
        }
    });
}

/**
 * HTTPS Get wrapper, invokes a callback with parsed JSON response or no data if failed.
 */ 
function httpsGet(hostname, timeoutInMillis, retries, path, args, headers, callback) {

    // https://nodejs.org/api/https.html#https_https_request_options_callback
    // https://nodejs.org/api/http.html#http_http_request_options_callback
    const errorType = 'HttpsGet-' + hostname;
    const options = {
        hostname: hostname,
        path: path + '?' + querystring.stringify(args),
        headers: Object.assign({}, headers, {'Accept' : 'application/json'}),
        method: 'GET'
    };
    
    log(' ==> [https://' + hostname + options.path + '], timeout is ' + timeoutInMillis + ' ms, ' + retries + ' retries');
    
    let statusCode  = -1;
    let timedOut = false;
    
    const handleHttpsError = (request, error, errorDescription) => {
        if (request) { request.abort(); }
        handleError(error, errorDescription, errorType);
        if (retries > 1) {
            const delayMs = 250 + randomNumber(100);
            log(hostname + " HTTPS request - failed, retrying in " + delayMs + " ms");
            setTimeout(() => { httpsGet(hostname, timeoutInMillis, retries - 1, path, args, headers, callback); }, 
                       delayMs);
        } else {
            log(hostname + " HTTPS request - failed, no more retries left");
            callback();
        }
    };
    
    const startTime = process.hrtime();
    const request = https.request(options, (response) => {
        statusCode = response.statusCode;
        log(hostname + ' - Response Code: ' + statusCode);
        let body = '';
        response.on('data', (data) => { body += data; });
        response.on('end', () => {
            const responseTime = process.hrtime(startTime);
            const responseTimeInMillis = parseFloat(((responseTime[0] + (responseTime[1] / 1e9)) * 1000).toFixed(2));

            log(hostname + ' - Response Time: ' + responseTimeInMillis + ' ms');
            emitCloudWatchMetric('HTTP-ResponseTime', 'Milliseconds', responseTimeInMillis, 'Hostname', hostname);
            
            if (statusCode == 200) {
                callback(JSON.parse(body));
            } else {
                handleHttpsError(request, '', hostname + " HTTPS request - status code is " + statusCode);
            }
        });
    });
    
    if (request) {
        request.setTimeout(timeoutInMillis, () => { 
            timedOut = true;
            handleHttpsError(request, '', hostname + " HTTPS request - timed out after " + timeoutInMillis + " ms"); 
        });
        request.on('error', (error) => { 
            if (! timedOut) {
                handleHttpsError(request, error, hostname + " HTTPS request - failed to send"); 
            }
        });
        request.end();
    } else {
        handleHttpsError(request, '', hostname + " HTTPS request - failed to create");
    }
}

/**
 * Attempts to set a default origin if user has enabled device postal code sharing
 */ 
function setDefaultOrigin(self, callback){
    const context = self.event.context;
    const currentDefaultOrigin = getDefaultOrigin(self);
    
    if (currentDefaultOrigin === defaultOrigin) {
        log("Default origin is still [" + currentDefaultOrigin + "], checking user permissions in request");
        
        if (context && context.System && context.System.user && 
            context.System.user.permissions && context.System.user.permissions.consentToken) {

            // https://developer.amazon.com/public/solutions/alexa/alexa-skills-kit/docs/device-address-api#get-the-consent-token-and-device-id
            
            log("ConsentToken is available in request");
            const consentToken = context.System.user.permissions.consentToken;
            const deviceId = getDeviceId(self);
            const path = '/v1/devices/' + deviceId + '/settings/address/countryAndPostalCode';
            
            httpsGet(ALEXA_ENDPOINT, ALEXA_ENDPOINT_TIMEOUT, ALEXA_ENDPOINT_RETRIES, path, {}, { Authorization: 'Bearer ' + consentToken }, 
                    (result) => {
                        log(result);
                        if (result && result.postalCode) {
                            self.attributes.defaultOrigin = result.postalCode;
                            log("Default origin is set to [" + getDefaultOrigin(self) + "] for [" + deviceId + "]");
                        } else {
                            log("Postal code is not available in response, default origin is still [" + getDefaultOrigin(self) + "]");
                        }
                        callback();
                    });
        } else {
            log("ConsentToken is not available in request, default origin is still [" + getDefaultOrigin(self) + "]");
            callback();
        }
    } else {
        log("Default origin is already modified to [" + getDefaultOrigin(self) + "]");
        callback();
    }
}

/**
 * Calculates a number of "driving days" for provided destination
 */ 
function getDrivingDays(duration) {
    const isDays = duration.includes('day');
    const isHours = duration.includes('hour');
    if (isDays || isHours) {
        const match = isDays && isHours ? duration.match(/(\d+)\s+days?\s+(\d+)\s+hours?/) :
                      isDays            ? duration.match(/(\d+)\s+days?/) :
                      isHours           ? duration.match(/(\d+)\s+hours?/) : 
                                          null;
        if (match) {
            const days  = isDays ? match[1] : 0;
            const hours = isDays && isHours ? match[2] : 
                          isHours           ? match[1] : 
                                              0;
            return Math.ceil(((parseInt(days) * 24) + parseInt(hours)) / drivingHoursPerDay);
        }
    }
    return 0;
}

/**
 * Cleans up Google Map address up to the second "," - if available and is not a postal code 
 */ 
function cleanupAddress(actualAddress, originalAddress, defaultAddress) {
    return (isPostalCode(originalAddress) || (originalAddress === defaultAddress) || (! actualAddress)) ? 
           originalAddress : actualAddress.split(/\s*,\s*/).slice(0, 2).join(', ');
}

/**
 * Returns a response for a origin => destination route found
 */ 
function buildHowFarRouteResponse(origin, destination, leg) {

    const actualOrigin = cleanupAddress(leg.start_address, origin, defaultOrigin);
    const actualDestination = cleanupAddress(leg.end_address, destination, defaultDestination);

    const duration = (leg.duration.text || 'NoDuration').replace(/ 0 mins/, '').replace(/ 0 hours/, '');
    const distance = (leg.distance.text || 'NoDistance').replace(/(\d+)\.\d+/g, '$1'); // a.b miles => a miles
    const ferries = (leg.steps || []).filter((step) => ('ferry' === step.maneuver)).length;  
    
    const shortDistance = duration.match(/^\d+ mins?$/);
    const drivingDays = getDrivingDays(duration);
    
    log("[" + origin + (actualOrigin !== origin ? ' (' + actualOrigin + ')' : '' ) + 
        "] => [" + 
        destination + (actualDestination !== destination ? ' (' + actualDestination + ')' : '') + ']: ' + 
        "[" + duration + "]/[" + distance + "]/[" + drivingDays + " driving days]/[" + ferries + " ferries]");
    
    return sayAsAddress(actualDestination || destination) + ' is ' + 
           (shortDistance ? random(['just', 'only', 'only']) + ' ' : '' ) + 
           duration + 
           (ferries > 0 ? ' and ' + ferries + ' ' + (ferries == 1 ? 'ferry' : 'ferries') : '') + 
           ' away (or ' + distance + ') ' + 
           'from ' + sayAsAddress(actualOrigin || origin) + '.' + 
           (drivingDays > 1 ? ' <break time="0.03s"/>That\'ll be about ' + drivingDays + ' days driving.' : 
                              '');
}

/**
 * Returns a response for no origin => destination route found
 */ 
function buildHowFarNoRouteResponse(origin, destination) {
    log("[" + origin + "] => [" + destination + "]: no route found");
    return random(['Hmm', 'Oh dear', 'Oh']) + ', ' +
           random(["I'm afraid", "it looks like"]) + ' ' + 
           random(["you can't drive", "there is no route", "there is no way", "there is no way to drive"]) +
           ' to ' + sayAsAddress(destination) + ' from ' + sayAsAddress(origin) + '.' + 
           (origin.startsWith('to ') || origin.includes(' to ') || destination.startsWith('to ') || destination.includes(' to ') ? 
                ' I can understand questions like <break time="0.1s"/> Las Vegas <break time="0.05s"/> or <break time="0.1s"/> Las Vegas from LAX.' : 
                '');
}

/**
 * Calculates how far is origin from destination and invokes a callback with corresponding response
 */ 
function howFar(origin, destination, callback){
    log("[" + origin + "] => [" + destination + "]");
   
    // https://developers.google.com/maps/documentation/directions/intro
    // https://maps.googleapis.com/maps/api/directions/json?origin=98006&destination=98008&mode=driving&alternatives=false&key=???
    
    httpsGet(MAPS_ENDPOINT, MAPS_ENDPOINT_TIMEOUT, MAPS_ENDPOINT_RETRIES, '/maps/api/directions/json', { 
        origin: origin,
        destination: destination,
        mode: 'driving',
        alternatives: 'false',
        key: process.env.MAPS_API_KEY
    }, {}, (result) => {
        if (result) {
            const response = (hasData(result.routes) && hasData(result.routes[0].legs)) ? 
                             buildHowFarRouteResponse(origin, destination, result.routes[0].legs[0]) : 
                             buildHowFarNoRouteResponse(origin, destination);
            callback(response + '\n\n' + waitingForInputDelayed);
        } else {
            // Google Maps API has failed after all retries
            callback('Oh dear, something went wrong.'); 
        }
    });
}

const handlers = {
    'LaunchRequest': function () {
        logEvent(this);
        updateSessionMetrics(this, false, false);
        setDefaultOrigin(this, () => tellWelcomeMessage(this));
    },
    'AMAZON.HelpIntent': function () {
        logEvent(this);
        updateSessionMetrics(this, false, false);
        setDefaultOrigin(this, () => tellWelcomeMessage(this));
    },
    'HowFarIntent': function () {
        logEvent(this);
        updateSessionMetrics(this, true, false);
        const slots = this.event.request.intent.slots;
        log(slots);
        setDefaultOrigin(this, () => {
            const origin = slotValue(slots.Origin, getDefaultOrigin(this));
            const destination = slotValue(slots.Destination, defaultDestination).
                                replace(/^\s*is\s*/, ''); // Destination may read as "is <destination>" in "How Far is <destination>"
            howFar(origin, destination, (response) => {  
                askWithCard(this, response, waitingForInput, 'How Far is ' + destination + ' from ' + origin + '?');
            });
        });
    },
    'AMAZON.CancelIntent': function () {
        logEvent(this);
        updateSessionMetrics(this, false, true);
        tellWithCard(this, complyResponse(), 'Session Ended', 'Bye-bye for now!');
    },
    'AMAZON.StopIntent': function () {
        logEvent(this);
        updateSessionMetrics(this, false, true);
        tellWithCard(this, complyResponse(), 'Session Ended', 'Bye-bye for now!');
    },
    'SessionEndedRequest': function () {
        logEvent(this);
        updateSessionMetrics(this, false, true);
        tellWithCard(this, complyResponse(), 'Session Ended', 'Bye-bye for now!');
    }
};

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

exports.handler = (event, context) => {
    const isTestRequest = ! (event.context && 
                             event.context.System && 
                             event.context.System.user && event.context.System.user.userId && 
                             event.context.System.device && event.context.System.device.deviceId);
    log('------- [' + event.request.type + '][' + (event.request.intent ? event.request.intent.name : '') + ']' + (isTestRequest ? '[TEST]' : '') + ' ---------------------------------------------------------------------');
    var alexa = Alexa.handler(event, context);
    alexa.APP_ID = APP_ID;
    alexa.registerHandlers(handlers);
    alexa.execute();
};

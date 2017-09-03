// * Accept departure time
// * Allow updating user's default origin
// * Alert on errors

'use strict';

const Alexa = require('alexa-sdk');
const AWS = require('aws-sdk');
AWS.config.update({region: 'us-east-1'});
const https = require('https');
const querystring = require('querystring');

const cloudwatch = new AWS.CloudWatch({apiVersion: '2010-08-01'});
const APP_ID = 'amzn1.ask.skill.77f9ca28-bcb2-453c-9795-69039d37c8fe';

const ALEXA_ENDPOINT = 'api.amazonalexa.com';
const MAPS_ENDPOINT = 'maps.googleapis.com';

const waitingForInput = 'Where would you like to go?';
const waitingForInputDelayed = ' <break time="0.5s"/> ' + waitingForInput;
const drivingHoursPerDay = 8;
const defaultLocation = 'Seattle, WA';
const defaultOrigin = 'Seattle, WA';

const samplePhrases = [
    'Mexico City', 
    '98006',
    'How far is Vegas from LAX ?'
]

const welcomeMessage = 'Welcome to "How Far" Alexa skill <break time="0.05s"/> telling how far your destination is in driving hours. ' + 
                       'You can say <break time="0.25s"/> <say-as interpret-as="address"> ' + samplePhrases[0] + ' </say-as>, ' +  
                       '<break time="0.4s"/> <say-as interpret-as="address"> ' + samplePhrases[1] + ' </say-as><break time="0.3s"/> ' + 
                       'Or <break time="0.3s"/> ' + samplePhrases[2] + '.';  
                      
const welcomeSpeechOutput = welcomeMessage + waitingForInputDelayed;
                      
const welcomeCardContent = samplePhrases.join('\n') + '\n\n' + waitingForInput;

const log = console.log;

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

function logEvent(self) {
    log(self.event);
    log("User: " + getUserId(self));
    log("Device: " + getDeviceId(self));
}

function random(array) {
    return(array[Math.floor(Math.random() * array.length)]);
}

function complyResponse() {
    return random(['Sure!', 'OK!', 'Done!', 'Got it', 'Done deal']);
}

function noRouteResponse() {
    return random(['Hmm', 'Oh dear', 'Oh']) + ', ' +
           random(["I'm afraid", "it looks like"]) + ' ' + 
           random(["you can't drive", "there is no route", "there is no way", "there is no way to drive"]);
}

function slotValue(slot, defaultValue) {
    return (slot ? (slot.value || defaultValue) : defaultValue);
}

function clearTags(s) {
    return (s || '').replace(/<[^>]+>/g, '');
}

function tellWithCard(self, speechOutput, cardTitle, cardContent) {
    cardTitle = clearTags(cardTitle);
    cardContent = clearTags(cardContent || speechOutput);
    log("tellWithCard: [" + clearTags(speechOutput) + "][" + cardTitle + "][" + cardContent + "]");
    self.emit(':tellWithCard', speechOutput, cardTitle, cardContent); 
}

function askWithCard(self, speechOutput, repromptSpeech, cardTitle, cardContent) {
    cardTitle = clearTags(cardTitle);
    cardContent = clearTags(cardContent || speechOutput);
    log("askWithCard: [" + clearTags(speechOutput) + "][" + cardTitle + "][" + cardContent + "]");
    self.emit(':askWithCard', speechOutput, repromptSpeech, cardTitle, cardContent); 
}

function tellWelcomeMessage(self) {
    let speechOutput = welcomeMessage + 
                       " <break time='0.3s'/> Your location is set to <say-as interpret-as='address'>" + getDefaultOrigin(self) + "</say-as>. " + 
                       waitingForInputDelayed; 
    askWithCard(self, speechOutput, waitingForInput, waitingForInput, welcomeCardContent);
}

// HTTP GET wrapper
function httpGet(hostname, timeoutInMillis, path, args, headers, callback) {

    // https://nodejs.org/api/https.html#https_https_request_options_callback
    // https://nodejs.org/api/http.html#http_http_request_options_callback
    const options = {
        hostname: hostname,
        path: path + '?' + querystring.stringify(args),
        headers: Object.assign({}, headers, {'Accept' : 'application/json'}),
        method: 'GET',
        timeout: timeoutInMillis
    };
    
    log('https://' + options.hostname + options.path);
    
    const startTime = process.hrtime();
    const request = https.request(options, (response) => {
        log(hostname + ' - Response Code: ' + response.statusCode);
        let body = '';
        response.on('data', (data) => { body += data; });
        response.on('end', () => {
            
            const responseTime = process.hrtime(startTime);
            const responseTimeInMillis = parseFloat(((responseTime[0] + (responseTime[1] / 1e9)) * 1000).toFixed(2));
            
            log(hostname + ' - Response Time: ' + responseTimeInMillis + ' milliseconds');
            
            var params = {
              MetricData: [{ MetricName: 'HTTP-ResponseTime', Dimensions: [{ Name: 'Hostname', Value: hostname }], Unit: 'Milliseconds', Value: responseTimeInMillis }],
              Namespace: 'HowFarLambda'
            };
            
            cloudwatch.putMetricData(params, (error) => { if (error) console.error(error); });
            
            callback(JSON.parse(body));
        });
    });
    
    if (request) {
        request.setTimeout(timeoutInMillis - 100, () => { console.error( "!!! [" + hostname + "] request has timed out after " + timeoutInMillis + " milliseconds" ); callback(); });
        request.on('error', (error) => { console.error(error); callback(); });
        request.end();
    } else {
        console.error('Failed to create an HTTPS request');
        callback();
    }
}

function getUserId(self) {
    return self.event.context ? self.event.context.System.user.userId : '';
}

function getDeviceId(self) {
    return self.event.context ? self.event.context.System.device.deviceId : '';
}

// https://developer.amazon.com/public/solutions/alexa/alexa-skills-kit/docs/device-address-api#get-the-consent-token-and-device-id
function setDefaultOrigin(self, callbackWhenDone){
    let context = self.event.context;
    self.attributes.defaultOrigin = defaultOrigin;
    
    if (context.System.user.permissions && context.System.user.permissions.consentToken) {
        
        let consentToken = context.System.user.permissions.consentToken;
        let deviceId = getDeviceId(self);
        let path = '/v1/devices/' + deviceId + '/settings/address/countryAndPostalCode';
        
        httpGet(ALEXA_ENDPOINT, 2000, path, {}, { Authorization: 'Bearer ' + consentToken }, 
                (result) => {
                    log(result);
                    if (result && result.postalCode && result.postalCode.match(/^[0-9]+$/)) {
                        let postalCode = result.postalCode;
                        self.attributes.defaultOrigin = postalCode;
                        log("Default origin is set to [" + getDefaultOrigin(self) + "] for [" + deviceId + "]");
                    } else {
                        log("Numeric postal code is not available in result, default origin is still [" + getDefaultOrigin(self) + "]");
                    }
                    callbackWhenDone();
                });
    } else {
        // No consentToken or deviceId available
        log("ConsentToken is not available in request, default origin is still [" + getDefaultOrigin(self) + "]");
        callbackWhenDone();
    }
}

function getDefaultOrigin(self) {
    return self.attributes.defaultOrigin || defaultOrigin;
}

function hasData(array){
    return (array && (array.length > 0));
}

function getDrivingDays(duration) {
    let isDays = duration.includes('day');
    let isHours = duration.includes('hour');
    if (isDays || isHours) {
        let match = isDays && isHours ? duration.match(/(\d+)\s+days?\s+(\d+)\s+hours?/) :
                    isDays            ? duration.match(/(\d+)\s+days?/) :
                    isHours           ? duration.match(/(\d+)\s+hours?/) : 
                                        null;
        if (match) {
            let days = isDays ? match[1] : 0;
            let hours = isDays && isHours ? match[2] : 
                        isHours           ? match[1] : 0;
            return Math.ceil(((parseInt(days) * 24) + parseInt(hours)) / drivingHoursPerDay);
        }
    }
    return 0;
}

// https://developers.google.com/maps/documentation/directions/intro
// https://maps.googleapis.com/maps/api/directions/json?origin=98006&destination=98008&mode=driving&alternatives=false&key=???
function howFar(location, origin, callback){
    log("Getting driving directions from [" + origin + "] to [" + location + "]");
    
    httpGet(MAPS_ENDPOINT, 2500, '/maps/api/directions/json', { 
        origin: origin,
        destination: location,
        mode: 'driving',
        alternatives: 'false',
        key: process.env.MAPS_API_KEY
    }, {}, (result) => {
        if (result) {
            let response = ''
            if (hasData(result.routes) && hasData(result.routes[0].legs)){
                let leg = result.routes[0].legs[0];
                let duration = (leg.duration.text || 'NoDuration').
                               replace(/ 0 mins/, '').replace(/ 0 hours/, '');  // (Vegas from 92708, Miami beach from Seattle, WA)
                let distance = (leg.distance.text || 'NoDistance').
                               replace(/(\d+)\.\d+/g, '$1'); // a.b miles => a miles
                let drivingDays = getDrivingDays(duration);
                let ferries = (leg.steps || []).filter(step => 'ferry' === step.maneuver).length;  
                log("[" + origin + "] => [" + location + "]: [" + duration + "]/[" + distance + "]/[" + drivingDays + " driving days]/[" + ferries + " ferries]");
                response = '<say-as interpret-as="address">' + location + '</say-as> is ' + duration + 
                           (ferries < 1 ? '' : ' and ' + ferries + ' ' + (ferries == 1 ? 'ferry' : 'ferries')) + 
                           ' away (or ' + distance + ') from <say-as interpret-as="address">' + origin + '</say-as>.' + 
                           (drivingDays > 1 ? ' <break time="0.03s"/>That\'ll be about ' + drivingDays + ' days driving.' : 
                                              '');
            } else {
                log("[" + origin + "] => [" + location + "]: no route found");
                response = noRouteResponse() +
                           ' to <say-as interpret-as="address">' + location + '</say-as> from <say-as interpret-as="address">' + origin + '</say-as>.';
            }
            
            callback(response + '\n\n' + waitingForInputDelayed);
        } else {
            callback('Oh dear, something went wrong.'); 
        }
    });
}

const handlers = {
    'LaunchRequest': function () {
        logEvent(this);
        setDefaultOrigin(this, () => tellWelcomeMessage(this));
    },
    'AMAZON.HelpIntent': function () {
        logEvent(this);
        tellWelcomeMessage(this);
    },
    'AMAZON.CancelIntent': function () {
        logEvent(this);
        tellWithCard(this, complyResponse(), 'Session Ended', 'Bye-bye for now!');
    },
    'AMAZON.StopIntent': function () {
        logEvent(this);
        tellWithCard(this, complyResponse(), 'Session Ended', 'Bye-bye for now!');
    },
    'SessionEndedRequest': function () {
        logEvent(this);
        tellWithCard(this, complyResponse(), 'Session Ended', 'Bye-bye for now!');
    },
    'HowFarIntent': function () {
        logEvent(this);
        let slots = this.event.request.intent.slots;
        log(slots);
        let location = slotValue(slots.Location, defaultLocation).replace(/^\s*is\s*/, ''); // Occasionally, location is read as "is <Location>"
        let origin = slotValue(slots.Origin, getDefaultOrigin(this));

        howFar(location, origin, (response) => {  
            askWithCard(this, response, waitingForInput, 'How Far is ' + location + ' from ' + origin + '?');
        });
    }
};


exports.handler = (event, context) => {
    let isTestRequest = ! (event.context && event.context.System && event.context.System.user && event.context.System.user.userId);
    log('------- [' + event.request.type + '][' + (event.request.intent ? event.request.intent.name : '') + ']' + (isTestRequest ? '[TEST]' : '') + ' ---------------------------------------------------------------------');
    var alexa = Alexa.handler(event, context);
    alexa.APP_ID = APP_ID;
    alexa.registerHandlers(handlers);
    alexa.execute();
};

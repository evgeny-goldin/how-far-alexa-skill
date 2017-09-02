// * Cache Google Maps results for 5 minutes
// * Accept departure time
// * Mention if route includes ferries, how many? (98110)
// * Allow changing user's default origin
// * Test with https://www.parentmap.com/calendar

'use strict';

const Alexa = require('alexa-sdk');
const https = require('https');
const querystring = require('querystring');
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

const digits = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

const welcomeMessage = 'Welcome to "How Far" Alexa skill <break time="0.05s"/> telling how far is your destination in driving hours. ' + 
                      'You can say <break time="0.25s"/> "' + samplePhrases[0] + 
                      '", <break time="0.4s"/> "nine eight zero zero six" <break time="0.3s"/> ' + 
                      'Or <break time="0.3s"/> "' + samplePhrases[2] + '".';  
                      
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
    let defaultOrigin = getDefaultOrigin(self);
    
    if (defaultOrigin.match(/^\d+$/)) {
        // 123 => "one two three"
        defaultOrigin = defaultOrigin.split('').map(digit => digits[parseInt(digit)]).join(' ');
    }
    
    let speechOutput = welcomeMessage + " <break time='0.3s'/> Your location is set to " + defaultOrigin + ". " + waitingForInputDelayed; 
    askWithCard(self, speechOutput, waitingForInput, waitingForInput, welcomeCardContent);
}

// HTTP GET wrapper
function httpGet(hostname, path, args, headers, callback) {

    const timerName = hostname + ' - Response Time';
    headers['Accept'] = 'application/json';

    const options = {
        hostname: hostname,
        path: path + '?' + querystring.stringify(args),
        headers: headers,
        method: 'GET'
    };
    
    log('Sending request to [https://' + options.hostname + options.path + ']');
    console.time(timerName);

    const request = https.request(options, (response) => {
        log(hostname + ' - Response Code: ' + response.statusCode);
        let body = '';
        response.on('data', (data) => { body += data; });
        response.on('end', () => {
            console.timeEnd(timerName); 
            callback(JSON.parse(body));
        });
    });
    
    if (request) {
        request.on('error', (e) => { console.error(e); callback(); });
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
        
        httpGet(ALEXA_ENDPOINT, path, {}, { Authorization: 'Bearer ' + consentToken }, 
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
    
    httpGet(MAPS_ENDPOINT, '/maps/api/directions/json', { 
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
                let duration = (leg.duration.text || 'NoDuration').replace(/ 0 mins/, '');  // 4 hours 0 mins => 4 hours (Vegas from 92708)
                let distance = (leg.distance.text || 'NoDistance').replace(/(\d+)\.\d+/g, '$1'); // a.b miles => a miles
                let drivingDays = getDrivingDays(duration);
                log("[" + origin + "] => [" + location + "]: [" + duration + "]/[" + distance + "]/[" + drivingDays + " driving days]");
                response = '<say-as interpret-as="address">' + location + '</say-as> is ' + duration + ' away (or ' + distance + ') from <say-as interpret-as="address">' + origin + '</say-as>.' + 
                           (drivingDays > 1 ? ' <break time="0.03s"/>That\'ll be about ' + drivingDays + ' days driving.' : 
                                            '');
            } else {
                log("[" + origin + "] => [" + location + "]: no route available");
                response = noRouteResponse() + ' to <say-as interpret-as="address">' + location + '</say-as> from <say-as interpret-as="address">' + origin + '</say-as>.';
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
    log('------- [' + event.request.type + '][' + (event.request.intent ? event.request.intent.name : '') + '] ---------------------------------------------------------------------');
    var alexa = Alexa.handler(event, context);
    alexa.APP_ID = APP_ID;
    // To enable string internationalization (i18n) features, set a resources object.
    //alexa.resources = languageStrings;
    alexa.registerHandlers(handlers);
    alexa.execute();
};

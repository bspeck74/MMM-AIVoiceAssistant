const NodeHelper = require("node_helper");
const https = require("https");
const { spawn, exec } = require('child_process');
const { Porcupine } = require("@picovoice/porcupine-node");
const recorder = require("node-record-lpcm16");
const { SpeechClient } = require('@google-cloud/speech');
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
const { google } = require('googleapis');
const path = require("path");
const fetch = require("node-fetch");
const ical = require('node-ical');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');

module.exports = NodeHelper.create({
    start: function() {
        console.log(`${this.name} helper started`);
        this.config = {};
        this.porcupine = null;
        this.speechClient = null;
        this.ttsClient = null;
        this.customsearch = null;
        this.mainRecorder = null;
        this.porcupineStream = null;
        this.googleStream = null;
        this.isListeningForCommand = false;
        this.chatHistory = [];
        this.reminders = {};
        this.commandTimeout = null;
    },

    socketNotificationReceived: function(notification, payload) {
        if (notification === "INIT_MODULE") {
            this.config = payload;
            this.initializeAssistant();
        }
    },

    initializeAssistant: async function() {
        try {
            const auth = new google.auth.GoogleAuth({
                keyFile: this.config.googleSpeechCredentials,
                scopes: [
                    'https://www.googleapis.com/auth/cloud-platform',
                    'https://www.googleapis.com/auth/cse'
                ],
            });
            const authClient = await auth.getClient();
            google.options({ auth: authClient });

            this.speechClient = new SpeechClient({ authClient });
            this.ttsClient = new TextToSpeechClient({ authClient });
            this.customsearch = google.customsearch('v1');

            const porcupineAccessKey = this.config.porcupineAccessKey;
            const keywordPath = path.join(this.path, this.config.porcupineKeywordPath);
            this.porcupine = new Porcupine(porcupineAccessKey, [keywordPath], [0.5]);

            this.mainRecorder = recorder.record({
                sampleRate: this.porcupine.sampleRate,
                channels: 1,
                dataType: "int16",
                recorder: "arecord",
            });

            this.mainRecorder.stream().on('error', (err) => console.error("Recorder Error:", err));
            this.listenForHotword();

        } catch (error) {
            console.error("Failed to initialize assistant:", error);
            this.sendSocketNotification("STATUS_UPDATE", { status: "ERROR", text: "Initialization Failed. Check logs." });
        }
    },

    listenForHotword: function() {
        if (!this.mainRecorder || this.isListeningForCommand) return;
        this.isListeningForCommand = false;
        console.log("Listening for hotword...");
        this.sendSocketNotification("STATUS_UPDATE", { status: "IDLE", text: `Say "${this.config.wakeWord}"` });

        this.porcupineStream = this.mainRecorder.stream();
        let audioBuffer = [];
        const frameLength = this.porcupine.frameLength;

        this.porcupineStream.on('data', (chunk) => {
            const newSamples = new Int16Array(chunk.buffer, 0, chunk.length / Int16Array.BYTES_PER_ELEMENT);
            audioBuffer = audioBuffer.concat(Array.from(newSamples));

            while (audioBuffer.length >= frameLength) {
                const frame = audioBuffer.slice(0, frameLength);
                audioBuffer = audioBuffer.slice(frameLength);
                const keywordIndex = this.porcupine.process(frame);

                if (keywordIndex !== -1) {
                    console.log("Hotword detected!");
                    this.porcupineStream.pause();
                    this.handleCommand();
                    return;
                }
            }
        });
    },

    handleCommand: function() {
        if (this.isListeningForCommand) return;
        this.isListeningForCommand = true;
        this.sendSocketNotification("STATUS_UPDATE", { status: "LISTENING", text: "Listening..." });

        let commandStarted = false;

        this.googleStream = this.speechClient.streamingRecognize({
            config: { encoding: 'LINEAR16', sampleRateHertz: 16000, languageCode: 'en-US' },
            interimResults: true,
        })
        .on('error', (err) => {
            console.error('Speech API Error:', err);
            this.resetToHotword();
        })
        .on('data', (data) => {
            if (!commandStarted) {
                commandStarted = true;
                clearTimeout(this.commandTimeout);
            }

            const transcript = data.results[0]?.alternatives[0]?.transcript;
            if (transcript) {
                this.sendSocketNotification("TRANSCRIPT_UPDATE", { transcript: transcript });
            }
            if (data.results[0] && data.results[0].isFinal) {
                this.mainRecorder.stream().unpipe(this.googleStream);
                this.googleStream.end();
                this.processAIRequest({ message: transcript, chatHistory: this.chatHistory });
            }
        });
        
        this.mainRecorder.stream().unpipe();
        this.mainRecorder.stream().pipe(this.googleStream);

        this.commandTimeout = setTimeout(() => {
            if (this.isListeningForCommand) {
                this.resetToHotword();
            }
        }, 20000);
    },

    resetToHotword: function() {
        clearTimeout(this.commandTimeout);
        if (this.googleStream) {
            this.mainRecorder.stream().unpipe(this.googleStream);
            this.googleStream.end();
            this.googleStream = null;
        }
        if (this.porcupineStream) {
            this.porcupineStream.resume();
        }
        this.isListeningForCommand = false;
        this.sendSocketNotification("STATUS_UPDATE", { status: "IDLE", text: `Say "${this.config.wakeWord}"` });
    },

    processAIRequest: async function(data) {
        this.sendSocketNotification("STATUS_UPDATE", { status: "PROCESSING", text: "Thinking..." });
        try {
            let aiResponse;
            if (this.config.aiProvider === "gemini") {
                aiResponse = await this.callGeminiWithTools(data);
            } else {
                aiResponse = await this.callOpenAI(data);
            }
            
            this.chatHistory.push({ role: 'user', content: data.message });
            this.chatHistory.push({ role: 'model', content: aiResponse.content });
            if (this.chatHistory.length > 10) { this.chatHistory = this.chatHistory.slice(-10); }

            this.sendSocketNotification("AI_RESPONSE_TEXT", { ...aiResponse, chatHistory: this.chatHistory });
            await this.getAndPlayAudio(aiResponse.content);

        } catch (error) {
            console.error("AI request error:", error);
            this.sendSocketNotification("AI_ERROR", { message: error.message });
            this.resetToHotword();
        }
    },

    googleSearch: async function(args) {
        if (!this.config.googleSearchApiKey || !this.config.googleSearchEngineId) {
            return JSON.stringify({ error: "Google Search is not configured." });
        }
        try {
            const res = await this.customsearch.cse.list({
                cx: this.config.googleSearchEngineId,
                q: args.query,
            });
            if (res.data.items && res.data.items.length > 0) {
                const snippets = res.data.items.slice(0, 3).map(item => item.snippet);
                return JSON.stringify(snippets);
            }
            return JSON.stringify({ error: "No search results found." });
        } catch (error) {
            console.error("Google Search API Error:", error);
            return JSON.stringify({ error: "Failed to perform Google search." });
        }
    },

    getCurrentWeather: async function(args) {
        if (!this.config.weather || !this.config.weather.apiKey) {
            return JSON.stringify({ error: "Weather function is not configured." });
        }
        const locationQuery = (args && args.location) ? args.location : `${this.config.weather.city},${this.config.weather.state}`;
        const url = `http://api.weatherapi.com/v1/current.json?key=${this.config.weather.apiKey}&q=${encodeURIComponent(locationQuery)}&aqi=no`;
        try {
            const response = await fetch(url);
            const data = await response.json();
            if (data.error) { return JSON.stringify({ error: data.error.message }); }
            const weather = {
                temperature: data.current.temp_f,
                condition: data.current.condition.text,
                location: data.location.name,
            };
            return JSON.stringify(weather);
        } catch (error) {
            return JSON.stringify({ error: "Failed to fetch weather data." });
        }
    },

    getCurrentTime: async function() {
        const now = new Date();
        const formattedDate = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        const formattedTime = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
        return JSON.stringify({ date: formattedDate, time: formattedTime });
    },

    setReminder: async function(args) {
        const { delayInMinutes, subject } = args;
        const delayInMs = delayInMinutes * 60 * 1000;
        if (this.reminders[subject]) { clearTimeout(this.reminders[subject]); }
        this.reminders[subject] = setTimeout(() => {
            this.sendSocketNotification("SHOW_ALERT", {
                type: "notification",
                title: "Reminder!",
                message: subject,
                timer: 10000
            });
            delete this.reminders[subject];
        }, delayInMs);
        return JSON.stringify({ status: `Reminder set for '${subject}' in ${delayInMinutes} minutes.` });
    },

    getCalendarEvents: async function() {
        if (!this.config.calendar || !this.config.calendar.url) {
            return JSON.stringify({ error: "Calendar URL is not configured." });
        }
        try {
            const events = await ical.async.fromURL(this.config.calendar.url);
            const now = new Date();
            const future = new Date();
            future.setDate(now.getDate() + (this.config.calendar.maxDays || 7));
            const upcomingEvents = [];
            for (const event of Object.values(events)) {
                if (event.type === 'VEVENT') {
                    const start = new Date(event.start);
                    if (start >= now && start <= future) {
                        upcomingEvents.push({
                            summary: event.summary,
                            date: start.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
                        });
                    }
                }
            }
            if (upcomingEvents.length === 0) {
                return JSON.stringify({ message: "No upcoming events found in the calendar." });
            }
            return JSON.stringify(upcomingEvents);
        } catch (error) {
            return JSON.stringify({ error: "Failed to fetch or parse calendar data." });
        }
    },

    createImage: async function(args) {
        const { GoogleGenerativeAI } = require("@google/generative-ai");
        const genAI = new GoogleGenerativeAI(this.config.geminiApiKey);
        const model = genAI.getGenerativeModel({ model: "imagen-2" });
        try {
            const result = await model.generateImages(args.prompt);
            const imageData = result.images[0].buffer.toString('base64');
            this.sendSocketNotification("SHOW_IMAGE", { imageData });
            return JSON.stringify({ status: "Image is being generated." });
        } catch (error) {
            console.error("Image generation error:", error);
            return JSON.stringify({ error: "Sorry, I was unable to create that image." });
        }
    },

    rebootMirror: function() {
        console.log("Executing reboot command...");
        exec("sudo reboot", (error, stdout, stderr) => {
            if (error) {
                console.error(`Reboot error: ${error}`);
                return JSON.stringify({ error: "Failed to reboot." });
            }
        });
        return JSON.stringify({ status: "Rebooting now." });
    },

    deepResearchAndEmail: async function(args) {
        const { topic, emailAddress } = args;
        const targetEmail = emailAddress || this.config.email.defaultEmail;

        if (!targetEmail) {
            return JSON.stringify({ error: "No email address was provided and no default is configured." });
        }
        if (!this.config.email || !this.config.email.user || !this.config.email.pass) {
            return JSON.stringify({ error: "Email sending is not configured on the mirror." });
        }

        console.log(`Starting deep research on: ${topic}`);
        let searchResults = [];
        const searchQueries = [`${topic} summary`, `key facts about ${topic}`, `history of ${topic}`];
        for (const query of searchQueries) {
            const resultText = await this.googleSearch({ query });
            const result = JSON.parse(resultText);
            if (!result.error) {
                searchResults.push(...result);
            }
        }
        const researchText = searchResults.join("\n\n");

        // --- FIX: Correctly buffer the PDF data ---
        const pdfBuffer = await new Promise((resolve) => {
            const doc = new PDFDocument();
            const buffers = [];
            doc.on('data', buffers.push.bind(buffers));
            doc.on('end', () => {
                resolve(Buffer.concat(buffers));
            });
            doc.fontSize(25).text(`Research on: ${topic}`, { align: 'center' });
            doc.moveDown();
            doc.fontSize(12).text(researchText);
            doc.end();
        });
        // --- END OF FIX ---

        let transportOptions;
        if (this.config.email.service) {
            transportOptions = {
                service: this.config.email.service,
                auth: { user: this.config.email.user, pass: this.config.email.pass },
            };
        } else {
            transportOptions = {
                host: this.config.email.host,
                port: this.config.email.port,
                secure: this.config.email.secure,
                auth: { user: this.config.email.user, pass: this.config.email.pass },
            };
        }
        const transporter = nodemailer.createTransport(transportOptions);

        const mailOptions = {
            from: this.config.email.user,
            to: targetEmail,
            subject: `Your Magic Mirror Research: ${topic}`,
            text: `Here is the research you requested on "${topic}".`,
            attachments: [{
                filename: `${topic}_research.pdf`,
                content: pdfBuffer,
                contentType: 'application/pdf'
            }],
        };

        try {
            await transporter.sendMail(mailOptions);
            console.log("Research email sent successfully.");
            return JSON.stringify({ status: `Research on "${topic}" has been sent to ${targetEmail}.` });
        } catch (error) {
            console.error("Failed to send email:", error);
            return JSON.stringify({ error: "Failed to send the research email." });
        }
    },

    callGeminiWithTools: async function(data) {
        const { GoogleGenerativeAI } = require("@google/generative-ai");
        const genAI = new GoogleGenerativeAI(this.config.geminiApiKey);
        
        const tools = [{
            functionDeclarations: [
                { name: "googleSearch", description: "Search Google for real-time information.", parameters: { type: "OBJECT", properties: { query: { type: "STRING" } }, required: ["query"] } },
                { name: "getCurrentWeather", description: "Get the current weather.", parameters: { type: "OBJECT", properties: { location: { type: "STRING", description: "Optional: The city and state." } } } },
                { name: "getCurrentTime", description: "Get the current time and date.", parameters: { type: "OBJECT", properties: {} } },
                { name: "createImage", description: "Create a new image.", parameters: { type: "OBJECT", properties: { prompt: { type: "STRING" } }, required: ["prompt"] } },
                { name: "setReminder", description: "Set a reminder.", parameters: { type: "OBJECT", properties: { delayInMinutes: { type: "NUMBER" }, subject: { type: "STRING" } }, required: ["delayInMinutes", "subject"] } },
                { name: "getCalendarEvents", description: "Get upcoming calendar events.", parameters: { type: "OBJECT", properties: {} } },
                { name: "rebootMirror", description: "Reboot the device.", parameters: { type: "OBJECT", properties: {} } },
                { 
                    name: "deepResearchAndEmail", 
                    description: "Performs in-depth research on a topic and emails the results. CRITICAL: If the user does not specify an email address, you MUST use the default email address configured on the system. Do not ask for one.", 
                    parameters: { 
                        type: "OBJECT", 
                        properties: { 
                            topic: { type: "STRING" }, 
                            emailAddress: { type: "STRING", description: "Optional: The email to send to. Uses default if not provided." } 
                        }, 
                        required: ["topic"] 
                    } 
                }
            ]
        }];

        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash", 
            tools,
            systemInstruction: this.config.systemPrompt
        });
        
        const formattedHistory = this.chatHistory.map(item => ({
            role: item.role,
            parts: [{ text: item.content }]
        }));
        const chat = model.startChat({ history: formattedHistory });

        const result = await chat.sendMessage(data.message);
        const response = result.response;
        const functionCall = response.functionCalls()?.[0];

        if (functionCall) {
            console.log("Gemini requested a function call:", functionCall.name, "with args:", functionCall.args);
            let apiResponse;
            if (functionCall.name === "googleSearch") { apiResponse = await this.googleSearch(functionCall.args); }
            else if (functionCall.name === "getCurrentWeather") { apiResponse = await this.getCurrentWeather(functionCall.args); }
            else if (functionCall.name === "getCurrentTime") { apiResponse = await this.getCurrentTime(); }
            else if (functionCall.name === "createImage") { apiResponse = await this.createImage(functionCall.args); }
            else if (functionCall.name === "setReminder") { apiResponse = await this.setReminder(functionCall.args); }
            else if (functionCall.name === "getCalendarEvents") { apiResponse = await this.getCalendarEvents(); }
            else if (functionCall.name === "rebootMirror") { apiResponse = this.rebootMirror(); }
            else if (functionCall.name === "deepResearchAndEmail") { apiResponse = await this.deepResearchAndEmail(functionCall.args); }

            if (apiResponse) {
                const result2 = await chat.sendMessage([{
                    functionResponse: {
                        name: functionCall.name,
                        response: { name: functionCall.name, content: apiResponse }
                    }
                }]);
                const finalResponse = result2.response.text();
                return { content: finalResponse, provider: "gemini" };
            }
        }
        
        return { content: response.text(), provider: "gemini" };
    },

   getAndPlayAudio: function(text) {
        return new Promise((resolve, reject) => {
            const postData = JSON.stringify({
                input: { text: text },
                voice: { languageCode: 'en-US', ssmlGender: 'NEUTRAL' },
                audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 24000 }
            });
            const options = {
                hostname: 'texttospeech.googleapis.com',
                port: 443,
                path: `/v1/text:synthesize?key=${this.config.geminiApiKey}`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
            };
            const req = https.request(options, (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(Buffer.concat(chunks).toString());
                        if (parsed.audioContent) {
                            const audioBuffer = Buffer.from(parsed.audioContent, 'base64');
                            const aplay = spawn('aplay', ['-r', '24000', '-f', 'S16_LE']);
                            aplay.stdin.write(audioBuffer);
                            aplay.stdin.end();
                            aplay.on('close', () => {
                                this.sendSocketNotification("AI_AUDIO_FINISHED");
                                this.resetToHotword();
                                resolve();
                            });
                        } else { 
                            console.error("TTS Error:", parsed);
                            this.resetToHotword();
                            reject(new Error("No audio content in TTS response")); 
                        }
                    } catch (e) { this.resetToHotword(); reject(e); }
                });
            });
            req.on('error', (err) => { this.resetToHotword(); reject(err); });
            req.write(postData);
            req.end();
        });
    },

    callOpenAI: function(data) {
        return new Promise((resolve, reject) => {
            const messages = [
                { role: "system", content: this.config.systemPrompt },
                ...data.chatHistory.slice(-6),
                { role: "user", content: data.message }
            ];
            const postData = JSON.stringify({
                model: "gpt-3.5-turbo",
                messages: messages,
                max_tokens: 150,
                temperature: 0.7
            });
            const options = {
                hostname: 'api.openai.com',
                port: 443,
                path: '/v1/chat/completions',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.config.openaiApiKey}`,
                    'Content-Length': Buffer.byteLength(postData)
                }
            };
            const req = https.request(options, (res) => {
                let responseData = '';
                res.on('data', (chunk) => { responseData += chunk; });
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(responseData);
                        if (parsed.choices && parsed.choices[0]) {
                            resolve({ content: parsed.choices[0].message.content, provider: "openai" });
                        } else { 
                            console.error("OpenAI Error:", parsed);
                            reject(new Error("Invalid OpenAI response")); 
                        }
                    } catch (error) { reject(error); }
                });
            });
            req.on('error', reject);
            req.write(postData);
            req.end();
        });
    },
});

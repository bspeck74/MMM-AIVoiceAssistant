const NodeHelper = require("node_helper");
const https = require("https");
const { spawn } = require('child_process');
const { Porcupine } = require("@picovoice/porcupine-node");
const recorder = require("node-record-lpcm16");
const { SpeechClient } = require('@google-cloud/speech');
const path = require("path");

module.exports = NodeHelper.create({
    start: function() {
        console.log(`${this.name} helper started`);
        this.config = {};
        this.porcupine = null;
        this.recorder = null;
        this.speechClient = null;
        this.isListeningForCommand = false;
        this.chatHistory = []; // Initialize chat history
    },

    socketNotificationReceived: function(notification, payload) {
        if (notification === "INIT_MODULE") {
            this.config = payload;
            this.initializeAssistant();
        }
    },

    initializeAssistant: function() {
        try {
            this.speechClient = new SpeechClient({
                keyFilename: this.config.googleSpeechCredentials
            });

            const porcupineAccessKey = this.config.porcupineAccessKey;
            const keywordPath = path.join(this.path, this.config.porcupineKeywordPath);
            
            this.porcupine = new Porcupine(porcupineAccessKey, [keywordPath], [0.5]);

            const frameLength = this.porcupine.frameLength;
            const sampleRate = this.porcupine.sampleRate;

            this.recorder = recorder.record({
                sampleRate: sampleRate,
                channels: 1,
                dataType: "int16",
                recorder: "arecord",
            });

            console.log("Listening for hotword...");
            this.sendSocketNotification("STATUS_UPDATE", { status: "IDLE", text: `Say "${this.config.wakeWord}"` });

            let audioBuffer = [];
            this.recorder.stream().on('data', (chunk) => {
                const newSamples = new Int16Array(chunk.buffer, 0, chunk.length / Int16Array.BYTES_PER_ELEMENT);
                audioBuffer = audioBuffer.concat(Array.from(newSamples));

                while (audioBuffer.length >= frameLength) {
                    const frame = audioBuffer.slice(0, frameLength);
                    audioBuffer = audioBuffer.slice(frameLength);
                    const keywordIndex = this.porcupine.process(frame);

                    if (keywordIndex !== -1) {
                        console.log("Hotword detected!");
                        this.handleHotword();
                        return;
                    }
                }
            });

        } catch (error) {
            console.error("Failed to initialize assistant:", error);
            this.sendSocketNotification("STATUS_UPDATE", { status: "ERROR", text: "Initialization Failed. Check logs." });
        }
    },

    handleHotword: function() {
        if (this.isListeningForCommand) return;
        this.isListeningForCommand = true;

        // Gracefully stop the hotword recorder FIRST
        if (this.recorder) {
            this.recorder.stop();
            this.recorder = null;
        }
        if (this.porcupine) {
            this.porcupine.release();
            this.porcupine = null;
        }

        // A short delay to ensure the microphone hardware is released
        setTimeout(() => {
            this.sendSocketNotification("STATUS_UPDATE", { status: "LISTENING", text: "Listening..." });

            const recognizeStream = this.speechClient.streamingRecognize({
                config: { encoding: 'LINEAR16', sampleRateHertz: 16000, languageCode: 'en-US' },
                interimResults: true,
            })
            .on('error', (err) => {
                console.error('Speech API Error:', err);
                this.resetToHotword();
            })
            .on('data', (data) => {
                const transcript = data.results[0]?.alternatives[0]?.transcript;
                if (transcript) {
                    this.sendSocketNotification("TRANSCRIPT_UPDATE", { transcript: transcript });
                }
                if (data.results[0] && data.results[0].isFinal) {
                    commandRecorder.stop();
                    recognizeStream.end();
                    // Pass the chat history along with the message
                    this.processAIRequest({ message: transcript, chatHistory: this.chatHistory });
                }
            });

            const commandRecorder = recorder.record({
                sampleRate: 16000,
                threshold: 0,
                recorder: 'arecord',
            });
            commandRecorder.stream().pipe(recognizeStream);

            setTimeout(() => {
                if (this.isListeningForCommand) {
                    commandRecorder.stop();
                    this.resetToHotword();
                }
            }, 10000);
        }, 250); // 250ms delay
    },

    resetToHotword: function() {
        this.isListeningForCommand = false;
        setTimeout(() => this.initializeAssistant(), 100);
    },

    processAIRequest: async function(data) {
        this.sendSocketNotification("STATUS_UPDATE", { status: "PROCESSING", text: "Thinking..." });
        try {
            let aiResponse;
            switch (this.config.aiProvider) {
                case "openai":
                case "chatgpt":
                    aiResponse = await this.callOpenAI(data);
                    break;
                case "gemini":
                    aiResponse = await this.callGemini(data);
                    break;
                default:
                    throw new Error("Invalid AI provider");
            }
            
            // Update chat history
            this.chatHistory.push({ role: 'user', content: data.message });
            this.chatHistory.push({ role: 'assistant', content: aiResponse.content });
            if (this.chatHistory.length > 10) { // Keep history trimmed
                this.chatHistory = this.chatHistory.slice(-10);
            }

            this.sendSocketNotification("AI_RESPONSE_TEXT", { ...aiResponse, chatHistory: this.chatHistory });
            await this.getAndPlayAudio(aiResponse.content);

        } catch (error) {
            console.error("AI request error:", error);
            this.sendSocketNotification("AI_ERROR", { message: error.message });
            this.resetToHotword();
        }
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
                            reject(new Error("No audio content in TTS response")); 
                        }
                    } catch (e) { reject(e); }
                });
            });
            req.on('error', reject);
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

    callGemini: function(data) {
        return new Promise((resolve, reject) => {
            const postData = JSON.stringify({
                contents: [{ parts: [{ text: `${this.config.systemPrompt}\n\nUser: ${data.message}` }] }],
                generationConfig: { maxOutputTokens: 150, temperature: 0.7 }
            });
            const options = {
                hostname: 'generativelanguage.googleapis.com',
                port: 443,
                path: `/v1beta/models/gemini-pro:generateContent?key=${this.config.geminiApiKey}`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
            };
            const req = https.request(options, (res) => {
                let responseData = '';
                res.on('data', (chunk) => { responseData += chunk; });
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(responseData);
                        if (parsed.candidates && parsed.candidates[0]) {
                            resolve({ content: parsed.candidates[0].content.parts[0].text, provider: "gemini" });
                        } else { 
                            console.error("Gemini Error:", parsed);
                            reject(new Error("Invalid Gemini response")); 
                        }
                    } catch (error) { reject(error); }
                });
            });
            req.on('error', reject);
            req.write(postData);
            req.end();
        });
    }
});

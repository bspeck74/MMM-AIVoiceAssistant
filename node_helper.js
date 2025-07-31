// Node helper file: MMM-AIVoiceAssistant/node_helper.js
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
    },

    socketNotificationReceived: function(notification, payload) {
        if (notification === "INIT_MODULE") {
            this.config = payload;
            // We now initialize everything here instead of on the front-end
            this.initializeAssistant();
        }
    },

    initializeAssistant: function() {
        try {
            // 1. Initialize Google Speech-to-Text
            // IMPORTANT: This requires separate authentication. See module docs.
            this.speechClient = new SpeechClient({
                keyFilename: this.config.googleSpeechCredentials
            });

            // 2. Initialize Porcupine Hotword Detection
            const porcupineAccessKey = this.config.porcupineAccessKey; // Get this from Picovoice Console
            const keywordPath = path.join(this.path, this.config.porcupineKeywordPath);
            const keywordPaths = [keywordPath]; // Path to your .ppn file
            
            this.porcupine = new Porcupine(porcupineAccessKey, keywordPaths, [0.5]);

            const frameLength = this.porcupine.frameLength;
            const sampleRate = this.porcupine.sampleRate;

            // 3. Start listening for the hotword
            this.recorder = recorder.record({
                sampleRate: sampleRate,
                channels: 1,
                dataType: "int16",
                recorder: "arecord",
            });

            console.log("Listening for hotword...");
            this.sendSocketNotification("STATUS_UPDATE", { status: "IDLE", text: `Say "${this.config.wakeWord}"` });

            this.recorder.stream().on('data', (chunk) => {
                const frame = new Int16Array(chunk.buffer, 0, chunk.length / Int16Array.BYTES_PER_ELEMENT);
                const keywordIndex = this.porcupine.process(frame);

                if (keywordIndex !== -1) {
                    console.log("Hotword detected!");
                    this.handleHotword();
                }
            });

        } catch (error) {
            console.error("Failed to initialize assistant:", error);
            this.sendSocketNotification("STATUS_UPDATE", { status: "ERROR", text: "Initialization Failed" });
        }
    },

    handleHotword: function() {
        if (this.isListeningForCommand) return;

        this.isListeningForCommand = true;
        this.sendSocketNotification("STATUS_UPDATE", { status: "LISTENING", text: "Listening..." });

        // Stop the hotword recorder
        this.recorder.stop();
        this.porcupine.release();

        // Start a new recording for the user's command
        const recognizeStream = this.speechClient.streamingRecognize({
            config: {
                encoding: 'LINEAR16',
                sampleRateHertz: 16000,
                languageCode: 'en-US',
            },
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
                this.processAIRequest({ message: transcript });
            }
        });

        const commandRecorder = recorder.record({
            sampleRate: 16000,
            threshold: 0,
            verbose: false,
            recorder: 'arecord',
        });

        commandRecorder.stream().pipe(recognizeStream);

        // Timeout to stop listening after 10 seconds
        setTimeout(() => {
            if (this.isListeningForCommand) {
                commandRecorder.stop();
            }
        }, 10000);
    },

    resetToHotword: function() {
        this.isListeningForCommand = false;
        // Re-initialize to start listening for the hotword again
        this.initializeAssistant();
    },

    processAIRequest: async function(data) {
        try {
            let response;
            
            switch (this.config.aiProvider) {
                case "openai":
                case "chatgpt":
                    response = await this.callOpenAI(data);
                    break;
                case "gemini":
                    response = await this.callGemini(data);
                    break;
                default:
                    throw new Error("Invalid AI provider");
            }
            
            this.sendSocketNotification("AI_RESPONSE", response);
        } catch (error) {
            console.error("AI request error:", error);
            this.sendSocketNotification("AI_ERROR", error.message);
        }
    },

    callOpenAI: function(data) {
        return new Promise((resolve, reject) => {
            const messages = [
                { role: "system", content: this.config.systemPrompt },
                ...data.chatHistory.slice(-6), // Last 6 messages for context
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
                
                res.on('data', (chunk) => {
                    responseData += chunk;
                });
                
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(responseData);
                        if (parsed.choices && parsed.choices[0]) {
                            resolve({
                                content: parsed.choices[0].message.content,
                                provider: "openai"
                            });
                        } else {
                            reject(new Error("Invalid OpenAI response"));
                        }
                    } catch (error) {
                        reject(error);
                    }
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
                contents: [{
                    parts: [{
                        text: `${this.config.systemPrompt}\n\nUser: ${data.message}`
                    }]
                }],
                generationConfig: {
                    maxOutputTokens: 150,
                    temperature: 0.7
                }
            });

            const options = {
                hostname: 'generativelanguage.googleapis.com',
                port: 443,
                path: `/v1beta/models/gemini-pro:generateContent?key=${this.config.geminiApiKey}`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                }
            };

            const req = https.request(options, (res) => {
                let responseData = '';
                
                res.on('data', (chunk) => {
                    responseData += chunk;
                });
                
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(responseData);
                        if (parsed.candidates && parsed.candidates[0]) {
                            resolve({
                                content: parsed.candidates[0].content.parts[0].text,
                                provider: "gemini"
                            });
                        } else {
                            reject(new Error("Invalid Gemini response"));
                        }
                    } catch (error) {
                        reject(error);
                    }
                });
            });

            req.on('error', reject);
            req.write(postData);
            req.end();
        });
    }
});
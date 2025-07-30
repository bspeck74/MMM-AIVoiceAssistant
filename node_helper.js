// Node helper file: MMM-AIVoiceAssistant/node_helper.js
const NodeHelper = require("node_helper");
const https = require("https");

module.exports = NodeHelper.create({
    start: function() {
        console.log(`${this.name} helper started`);
        this.config = {};
    },

    socketNotificationReceived: function(notification, payload) {
        switch (notification) {
            case "INIT_MODULE":
                this.config = payload;
                break;
            case "PROCESS_AI_REQUEST":
                this.processAIRequest(payload);
                break;
        }
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
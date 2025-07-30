// MMM-AIVoiceAssistant/MMM-AIVoiceAssistant.js
Module.register("MMM-AIVoiceAssistant", {
    defaults: {
        // AI Provider Configuration
        aiProvider: "openai", // "openai", "gemini", or "chatgpt"
        openaiApiKey: "", // Your OpenAI API key
        geminiApiKey: "", // Your Google Gemini API key
        
        // Voice Configuration
        wakeWord: "hey redhawk", // Customizable wake word
        language: "en-US",
        voiceEnabled: true,
        speechRate: 1.0,
        speechPitch: 1.0,
        speechVolume: 1.0,
        
        // UI Configuration
        maxWidth: "600px",
        maxHeight: "400px",
        animationSpeed: 1000,
        showTranscript: true,
        autoHideDelay: 10000, // Hide after 10 seconds of inactivity
        
        // Chat Configuration
        maxChatHistory: 10,
        systemPrompt: "You are a helpful AI assistant for a college dorm smart mirror. Keep responses concise and friendly.",
        
        // Debug
        debug: false
    },

    start: function() {
        Log.info(`Starting module: ${this.name}`);
        this.isListening = false;
        this.isProcessing = false;
        this.chatHistory = [];
        this.currentTranscript = "";
        this.recognition = null;
        this.synthesis = null;
        this.hideTimer = null;
        this.microphoneError = false;
        this.audioStream = null;
        
        this.initializeSpeechRecognition();
        this.initializeSpeechSynthesis();
        this.sendSocketNotification("INIT_MODULE", this.config);
    },

    getDom: function() {
        const wrapper = document.createElement("div");
        wrapper.className = "ai-voice-assistant";
        wrapper.style.maxWidth = this.config.maxWidth;
        wrapper.style.maxHeight = this.config.maxHeight;

        // Status indicator
        const statusDiv = document.createElement("div");
        statusDiv.className = "status-indicator";
        
        if (this.microphoneError) {
            statusDiv.innerHTML = `
                <div class="status-icon error">
                    <i class="fas fa-microphone-slash"></i>
                </div>
                <div class="status-text error">
                    Microphone Error - Check permissions and setup
                </div>
            `;
        } else {
            statusDiv.innerHTML = `
                <div class="status-icon ${this.isListening ? 'listening' : 'idle'}">
                    <i class="fas ${this.isListening ? 'fa-microphone' : 'fa-microphone-slash'}"></i>
                </div>
                <div class="status-text">
                    ${this.isListening ? 'Listening...' : `Say "${this.config.wakeWord}" to start`}
                </div>
            `;
        }
        wrapper.appendChild(statusDiv);

        // Transcript display
        if (this.config.showTranscript && this.currentTranscript) {
            const transcriptDiv = document.createElement("div");
            transcriptDiv.className = "transcript";
            transcriptDiv.innerHTML = `<strong>You:</strong> ${this.currentTranscript}`;
            wrapper.appendChild(transcriptDiv);
        }

        // Chat history
        if (this.chatHistory.length > 0) {
            const chatDiv = document.createElement("div");
            chatDiv.className = "chat-history";
            
            this.chatHistory.slice(-3).forEach(message => {
                const messageDiv = document.createElement("div");
                messageDiv.className = `message ${message.role}`;
                messageDiv.innerHTML = `
                    <div class="message-role">${message.role === 'user' ? 'You' : 'AI'}:</div>
                    <div class="message-content">${message.content}</div>
                `;
                chatDiv.appendChild(messageDiv);
            });
            
            wrapper.appendChild(chatDiv);
        }

        // Processing indicator
        if (this.isProcessing) {
            const processingDiv = document.createElement("div");
            processingDiv.className = "processing";
            processingDiv.innerHTML = `
                <i class="fas fa-spinner fa-spin"></i>
                <span>Processing...</span>
            `;
            wrapper.appendChild(processingDiv);
        }

        return wrapper;
    },

    getStyles: function() {
        return [
            "MMM-AIVoiceAssistant.css",
            "font-awesome.css"
        ];
    },

    initializeSpeechRecognition: function() {
        // First try to get microphone permissions
        this.requestMicrophonePermission();
    },

    requestMicrophonePermission: function() {
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
            navigator.mediaDevices.getUserMedia({ 
                audio: {
                    deviceId: 'default',
                    sampleRate: 16000,
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                } 
            })
            .then((stream) => {
                this.log("Microphone permission granted");
                this.setupSpeechRecognition(stream);
                // Keep the stream active
                this.audioStream = stream;
            })
            .catch((error) => {
                Log.error("Microphone permission denied:", error);
                this.showMicrophoneError();
            });
        } else {
            Log.error("getUserMedia not supported");
            this.showMicrophoneError();
        }
    },

    setupSpeechRecognition: function(stream) {
        if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
            Log.error("Speech recognition not supported");
            this.showMicrophoneError();
            return;
        }

        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        this.recognition = new SpeechRecognition();
        
        this.recognition.continuous = true;
        this.recognition.interimResults = true;
        this.recognition.lang = this.config.language;
        this.recognition.maxAlternatives = 1;

        this.recognition.onstart = () => {
            this.log("Speech recognition started");
            this.microphoneError = false;
            this.updateDom();
        };

        this.recognition.onresult = (event) => {
            let finalTranscript = '';
            let interimTranscript = '';

            for (let i = event.resultIndex; i < event.results.length; i++) {
                const transcript = event.results[i][0].transcript;
                if (event.results[i].isFinal) {
                    finalTranscript += transcript;
                } else {
                    interimTranscript += transcript;
                }
            }

            const fullTranscript = (finalTranscript + interimTranscript).toLowerCase().trim();
            
            if (!this.isListening && fullTranscript.includes(this.config.wakeWord.toLowerCase())) {
                this.startListening();
            } else if (this.isListening && finalTranscript) {
                this.processVoiceInput(finalTranscript);
            }
        };

        this.recognition.onerror = (event) => {
            Log.error("Speech recognition error:", event.error);
            if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
                this.showMicrophoneError();
            } else {
                this.stopListening();
                // Try to restart after a delay
                setTimeout(() => {
                    if (this.config.voiceEnabled && !this.microphoneError) {
                        this.startRecognition();
                    }
                }, 2000);
            }
        };

        this.recognition.onend = () => {
            if (this.config.voiceEnabled && !this.microphoneError) {
                setTimeout(() => {
                    this.startRecognition();
                }, 1000);
            }
        };

        if (this.config.voiceEnabled) {
            this.startRecognition();
        }
    },

    startRecognition: function() {
        if (this.recognition && !this.microphoneError) {
            try {
                this.recognition.start();
            } catch (error) {
                this.log("Recognition start error: " + error.message);
                // Try again after a delay
                setTimeout(() => {
                    if (this.config.voiceEnabled) {
                        this.startRecognition();
                    }
                }, 3000);
            }
        }
    },

    showMicrophoneError: function() {
        this.microphoneError = true;
        this.updateDom();
    },

    initializeSpeechSynthesis: function() {
        if ('speechSynthesis' in window) {
            this.synthesis = window.speechSynthesis;
        } else {
            Log.error("Speech synthesis not supported");
        }
    },

    startListening: function() {
        this.isListening = true;
        this.currentTranscript = "";
        this.updateDom();
        this.log("Started listening for commands");
        
        // Auto-stop listening after 10 seconds
        setTimeout(() => {
            if (this.isListening) {
                this.stopListening();
            }
        }, 10000);
    },

    stopListening: function() {
        this.isListening = false;
        this.updateDom();
        this.scheduleHide();
    },

    processVoiceInput: function(transcript) {
        this.currentTranscript = transcript;
        this.isProcessing = true;
        this.stopListening();
        this.updateDom();

        this.log(`Processing voice input: ${transcript}`);
        
        // Send to AI API
        this.sendSocketNotification("PROCESS_AI_REQUEST", {
            message: transcript,
            chatHistory: this.chatHistory
        });
    },

    speak: function(text) {
        if (!this.synthesis) return;

        // Enhanced speech synthesis for more natural sound
        const utterance = new SpeechSynthesisUtterance(text);
        
        // Try to use a more natural voice
        const voices = this.synthesis.getVoices();
        const preferredVoices = this.config.preferredVoices || [
            "Google US English", "Microsoft Zira", "Alex", "Samantha"
        ];
        
        let selectedVoice = null;
        for (const preferred of preferredVoices) {
            selectedVoice = voices.find(voice => 
                voice.name.includes(preferred) || 
                (voice.name.includes("Google") && voice.lang === "en-US") ||
                (voice.name.includes("Microsoft") && voice.lang === "en-US")
            );
            if (selectedVoice) break;
        }
        
        // Fallback to best English voice
        if (!selectedVoice) {
            selectedVoice = voices.find(voice => 
                voice.lang === "en-US" && voice.name.includes("Female")
            ) || voices.find(voice => voice.lang === "en-US");
        }
        
        if (selectedVoice) {
            utterance.voice = selectedVoice;
            this.log(`Using voice: ${selectedVoice.name}`);
        }

        // Natural speech settings
        utterance.rate = this.config.speechRate || 0.9;
        utterance.pitch = this.config.speechPitch || 1.1;
        utterance.volume = this.config.speechVolume || 0.8;
        utterance.lang = this.config.language;

        // Add natural pauses for longer responses
        if (text.length > 100) {
            utterance.rate *= 0.9; // Slow down for longer responses
        }

        utterance.onend = () => {
            this.log("Finished speaking");
            this.scheduleHide();
        };

        utterance.onerror = (error) => {
            this.log("Speech synthesis error: " + error.error);
        };

        // Clear any existing speech and speak
        this.synthesis.cancel();
        this.synthesis.speak(utterance);
    },

    scheduleHide: function() {
        clearTimeout(this.hideTimer);
        this.hideTimer = setTimeout(() => {
            this.currentTranscript = "";
            this.updateDom();
        }, this.config.autoHideDelay);
    },

    socketNotificationReceived: function(notification, payload) {
        switch (notification) {
            case "AI_RESPONSE":
                this.handleAIResponse(payload);
                break;
            case "AI_ERROR":
                this.handleAIError(payload);
                break;
        }
    },

    handleAIResponse: function(response) {
        this.isProcessing = false;
        
        // Add to chat history
        this.chatHistory.push({
            role: 'user',
            content: this.currentTranscript
        });
        
        this.chatHistory.push({
            role: 'assistant',
            content: response.content
        });

        // Trim chat history
        if (this.chatHistory.length > this.config.maxChatHistory * 2) {
            this.chatHistory = this.chatHistory.slice(-this.config.maxChatHistory * 2);
        }

        this.updateDom();
        
        // Speak the response
        if (this.config.voiceEnabled) {
            this.speak(response.content);
        }
    },

    handleAIError: function(error) {
        this.isProcessing = false;
        this.updateDom();
        
        Log.error("AI Error:", error);
        
        if (this.config.voiceEnabled) {
            this.speak("Sorry, I encountered an error processing your request.");
        }
    },

    log: function(message) {
        if (this.config.debug) {
            Log.info(`[${this.name}] ${message}`);
        }
    }
});

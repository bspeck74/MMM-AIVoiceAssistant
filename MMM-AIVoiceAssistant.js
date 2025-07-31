// MMM-AIVoiceAssistant/MMM-AIVoiceAssistant.js
Module.register("MMM-AIVoiceAssistant", {
    defaults: {
        // AI Provider Configuration
        aiProvider: "gemini", // "openai", "gemini", or "chatgpt"
        openaiApiKey: "", // Your OpenAI API key
        geminiApiKey: "", // Your Google Gemini API key
         porcupineAccessKey: "", // Get from Picovoice Console
        
        // --- NEW CONFIG FOR BACK-END ---
        porcupineKeywordPath: "HeyRedhawk.ppn", // Path to your keyword file
        googleSpeechCredentials: "/home/pi/speech-credentials.json",
        wakeWord: "hey mirror",

        // UI Configuration
        maxWidth: "600px",
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
        this.status = "INITIALIZING";
        this.statusText = "Initializing...";
        this.transcript = "";
        this.chatHistory = [];
        
        this.sendSocketNotification("INIT_MODULE", this.config);
    },

    getDom: function() {
        const wrapper = document.createElement("div");
        wrapper.className = "ai-voice-assistant";
        wrapper.style.maxWidth = this.config.maxWidth;

        // Status indicator
        const statusDiv = document.createElement("div");
        statusDiv.className = "status-indicator";
        statusDiv.innerHTML = `
            <div class="status-icon ${this.status.toLowerCase()}">
                <i class="fas ${this.status === 'LISTENING' ? 'fa-microphone' : 'fa-microphone-slash'}"></i>
            </div>
            <div class="status-text">${this.statusText}</div>
        `;
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
        
        // Add these settings to improve "no-speech" detection
        this.recognition.grammars = null;
        
        this.recognitionActive = false; // Track recognition state

        this.recognition.onstart = () => {
            this.log("Speech recognition started");
            this.recognitionActive = true;
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
            this.log(`Speech detected: "${fullTranscript}"`);
            
            // More flexible wake word detection
            const wakeWords = this.config.wakeWord.toLowerCase().split(' ');
            const transcriptWords = fullTranscript.split(' ');
            
            let wakeWordDetected = false;
            
            // Check if all wake words are present (in any order within a window)
            if (wakeWords.every(word => transcriptWords.some(tWord => tWord.includes(word)))) {
                wakeWordDetected = true;
            }
            
            if (!this.isListening && wakeWordDetected) {
                this.log("Wake word detected!");
                this.startListening();
            } else if (this.isListening && finalTranscript) {
                this.processVoiceInput(finalTranscript);
            }
        };

        this.recognition.onerror = (event) => {
            this.log(`Speech recognition error: ${event.error}`);
            
            // Handle different error types
            switch(event.error) {
                case 'no-speech':
                    this.log("No speech detected - continuing to listen");
                    // Don't treat this as a fatal error, just continue
                    break;
                case 'audio-capture':
                    Log.error("Audio capture error - check microphone");
                    this.showMicrophoneError();
                    return;
                case 'not-allowed':
                case 'service-not-allowed':
                    Log.error("Microphone permission denied");
                    this.showMicrophoneError();
                    return;
                case 'network':
                    this.log("Network error - retrying");
                    break;
                default:
                    this.log(`Other error: ${event.error} - retrying`);
            }
            
            // For recoverable errors, restart after a delay
            this.recognitionActive = false;
            setTimeout(() => {
                if (this.config.voiceEnabled && !this.microphoneError) {
                    this.startRecognition();
                }
            }, 2000);
        };

        this.recognition.onend = () => {
            this.log("Speech recognition ended");
            this.recognitionActive = false;
            
            // Automatically restart if still enabled and no errors
            if (this.config.voiceEnabled && !this.microphoneError && !this.isListening) {
                setTimeout(() => {
                    this.startRecognition();
                }, 1000);
            }
        };

        // Start initial recognition
        if (this.config.voiceEnabled) {
            this.startRecognition();
        }
    },

    startRecognition: function() {
        // Prevent multiple simultaneous recognitions
        if (this.recognitionActive) {
            this.log("Recognition already active, skipping start");
            return;
        }
        
        if (this.recognition && !this.microphoneError) {
            try {
                this.log("Starting speech recognition...");
                this.recognition.start();
            } catch (error) {
                this.log("Recognition start error: " + error.message);
                if (error.message.includes('already started')) {
                    this.log("Recognition was already started, continuing");
                    this.recognitionActive = true;
                } else {
                    // Try again after a delay
                    setTimeout(() => {
                        if (this.config.voiceEnabled && !this.recognitionActive) {
                            this.startRecognition();
                        }
                    }, 3000);
                }
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
             case "STATUS_UPDATE":
                this.status = payload.status;
                this.statusText = payload.text;
                if (payload.status !== "LISTENING") {
                    this.transcript = ""; // Clear transcript when not listening
                }
                this.updateDom();
                break;
            case "TRANSCRIPT_UPDATE":
                this.transcript = payload.transcript;
                this.updateDom();
                break;
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
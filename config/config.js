/* Config
 *
 * For more information on how you can configure this file
 * see https://docs.magicmirror.builders/configuration/introduction.html
 * and https://docs.magicmirror.builders/modules/configuration.html
 */
let config = {
	address: "localhost",
	port: 8080,
	basePath: "/",
	ipWhitelist: ["127.0.0.1", "::ffff:127.0.0.1", "::1"],

	useHttps: false,
	httpsPrivateKey: "",
	httpsCertificate: "",

	language: "en",
	locale: "en-US",
	logLevel: ["INFO", "LOG", "WARN", "ERROR"],
	timeFormat: 12,
	units: "imperial",

	modules: [
		{
			module: "alert",
		},
		{
			module: "updatenotification",
			position: "top_bar"
		},
		{
			module: "clock",
			position: "top_bar", // Centered at the very top
      config: {
            displaySeconds: false
        }
		},
		{
			module: "weather",
			position: "top_right", // Far right
			config: {
				weatherProvider: "openmeteo",
				type: "current",
				lat: 39.5103,
				lon: -84.7352,
				units: "imperial",
				timeformat: 12
			}
		},
		{
			module: "weather",
			position: "top_right", // Far right
			header: "Weather Forecast",
			config: {
				weatherProvider: "openmeteo",
				type: "forecast",
				lat: 39.5103,
				lon: -84.7352,
				units: "imperial",
				timeformat: 12,
				maxNumberOfDays: 3
			}
		},
		{
			module: "MMM-AIVoiceAssistant",
			position: "middle_center", // In the center of the screen
			classes: "center-ai", // Custom class for styling
			config: {
				// Your existing AI config...
				aiProvider: "gemini",
				geminiApiKey: "AIzaSyBj4CftKXKfLlLrlrmVYOEwiECfOdz7IFM",
				googleSearchEngineId: "e3eb520d898874554",
				googleSearchApiKey: "AIzaSyCeqM8PLCi9qTHWzttpFv-Fd7IkFKdJ-pI",
				porcupineAccessKey: "rq1XFUsujpz8CsytQ/vZ7wg0uAmZooH0JWqZHJuoNdiOunEgh3jZwQ==",
				porcupineKeywordPath: "HeyRedhawk.ppn",
				googleSpeechCredentials: "/home/pi/speech-credentials.json",
				wakeWord: "hey Redhawk",
				voiceConfig: {
					languageCode: "en-US",
					name: "en-US-Standard-F",
					speakingRate: 0.9,
					pitch: 0.0
				},
				weather: {
					apiKey: "d0c353562e544d519e8190827253107",
					city: "Oxford",
					state: "OH",
				},
        email: {
            host: "mail.thespecks.net", // Your email provider's SMTP server
            port: 465,                   // The SMTP port (587 is common for TLS)
            secure: true,               // true for 465, false for other ports
            user: "miamiu@thespecks.net", // The dedicated sender email
            pass: "@Disney2026",      // The password for that email
            defaultEmail: "bspeck@gmail.com", //default email to send research to
        },
				systemPrompt: "You are 'Redhawk', a smart mirror AI assistant in a dorm room at Miami University in Oxford, Ohio. Your personality is witty, clever, slightly sarcastic, and you have a dark sense of humor, but you are always ultimately helpful. Your primary user is a college student. You MUST assume questions about academics, schedules, or campus life are about Miami University unless a different school is named. Your main purpose is to use the tools you have available to answer questions and perform tasks. If you don't know something, you must use your search tool to find an answer.",
			}
		},
		{
			module: "newsfeed",
			position: "bottom_bar", // At the very bottom
			classes: "small-news", // Custom class for styling
			config: {
				feeds: [
					{
						title: "Miami University",
						url: "https://miamioh.edu/student-life/news/filters/all-student-life-news.php",
					}
				],
				showSourceTitle: true,
				showPublishDate: true,
				broadcastNewsFeeds: true,
				broadcastNewsUpdates: true
			}
		}
	]
};

/*************** DO NOT EDIT THE LINE BELOW ***************/
if (typeof module !== "undefined") { module.exports = config; }

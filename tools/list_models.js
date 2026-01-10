// Usage: node tools/list_models.js YOUR_API_KEY

const apiKey = process.argv[2];

if (!apiKey) {
    console.error("Please provide your API Key as an argument.");
    console.error("Usage: node tools/list_models.js <YOUR_KEY>");
    process.exit(1);
}

const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;

console.log(`Querying: ${url.replace(apiKey, 'HIDDEN_KEY')}...`);

fetch(url)
    .then(response => response.json())
    .then(data => {
        if (data.error) {
            console.error("Error:", data.error.message);
        } else if (data.models) {
            console.log("\nAvailable Models:");
            data.models.forEach(model => {
                // Filter for generateContent support
                if (model.supportedGenerationMethods.includes("generateContent")) {
                    console.log(`- ${model.name}`);
                    console.log(`  Description: ${model.description.substring(0, 100)}...`);
                }
            });
        } else {
            console.log("No models found or unexpected response:", data);
        }
    })
    .catch(err => console.error("Request Failed:", err));

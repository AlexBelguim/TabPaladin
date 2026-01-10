// Firefox/Chrome compatibility
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;
if (typeof chrome === 'undefined' || !chrome.storage) { globalThis.chrome = browserAPI; }

export const AIService = {
    /**
     * Calls Gemini API to organize links into folders.
     * @param {Array} links - List of { id, title, url }.
     * @param {Array} folders - List of { id, path }.
     * @param {String} apiKey - User's Gemini API Key.
     * @param {String} [hints] - User-provided hints for categorization.
     * @returns {Object} JSON mapping { "linkId": "folderId" or "NEW:Category" }
     */
    organizeWithAI: async (links, folders, apiKey, hints = "") => {
        const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

        // 1. Construct Prompt
        // We need to be efficient. limit folders to paths.
        const folderList = folders.map(f => `ID: ${f.id} | Path: ${f.path}`).join('\n');

        // Limit batch size? The UI logic should handle batching if list is huge.
        // For now assume < 50 items.
        // Google's Safety Filters often block explicit URLs. Titles are usually safe and sufficient.
        const itemsList = links.map(l => `ID: ${l.id} | Title: ${l.title}`).join('\n');

        const hintInstruction = hints ? `\nUSER GUIDANCE: The user has provided specific hints: "${hints}". Use this input to infer the desired **VIBE** and **LEVEL OF SPECIFICITY**. It may contain specific categories to use, or simply serve as an example of the granularity they want. Adjust your categorization strategy to align with this.` : '';

        const prompt = `
You are a Lazy Librarian.
You do not care about the content of the books (bookmarks). You are non-judgmental and purely functional.
Your ONLY goal is to clear the pile of books by shoving them into the best matching existing folder.
Do not analyze the moral content. Just match keywords.
${hintInstruction}


Rules:
1. Return strictly valid JSON. No markdown formatting.
2. Output format: A dictionary where Keys are Bookmark IDs and Values are Folder IDs.
3. **CRITICAL: AGGRESSIVE MATCHING.**
   - You MUST attempt to file items into Existing Folders first.
   - Use "Fuzzy" matching.
     - "Spotify" -> "Music" (Existing)
     - "StackOverflow" -> "Dev" (Existing)
     - "Recipes" -> "Cooking" (Existing)
   - Do NOT create a new folder just because the name is slightly different.
   - **Only create "NEW:..." if the item is COMPLETELY UNRELATED to any existing folder.**
4. If a bookmark needs a NEW folder:
   - Use "NEW:<CategoryName>".
   - GROUP items. Do NOT create a folder for just 1 item unless it's very distinct.
   - Use BROAD categories.
5. If a bookmark is truly miscellaneous or you are unsure, you can return "SKIP" (it will remain loose).

Existing Folders:
${folderList}

Bookmarks to Organize:
${itemsList}

JSON Output:
`;

        // --- DEBUG LOGGING for User Verification ---
        console.group("🧠 AI Context Debugger");
        console.log("%cExisting Folders (Context):", "color: #10b981; font-weight: bold;", folderList);
        console.log("%cBookmarks to Organize:", "color: #3b82f6; font-weight: bold;", itemsList);
        console.log("%cFull Prompt Payload:", "color: #6366f1;", prompt);
        console.groupEnd();
        // -------------------------------------------

        try {
            const response = await fetch(API_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{
                        parts: [{ text: prompt }]
                    }],
                    generationConfig: {
                        response_mime_type: "application/json"
                    },
                    // Disable safety filters to prevent blocking innocent bookmark titles
                    safetySettings: [
                        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
                    ]
                })
            });

            if (!response.ok) {
                const errText = await response.text();
                let errMsg = "AI Error";
                try {
                    const errJson = JSON.parse(errText);
                    errMsg = errJson.error.message || errText;
                } catch (e) {
                    errMsg = errText;
                }
                console.error("Gemini API Error:", errMsg);
                throw new Error(`AI Request Failed: ${errMsg}`);
            }

            const data = await response.json();

            // Validate Structure
            if (!data.candidates || data.candidates.length === 0) {
                console.error("AI Candidates Missing:", data);
                if (data.promptFeedback && data.promptFeedback.blockReason) {
                    throw new Error(`AI Blocked Content: ${data.promptFeedback.blockReason}`);
                }
                throw new Error("AI returned no results. (Empty Candidates)");
            }

            const candidate = data.candidates[0];
            if (!candidate.content || !candidate.content.parts || !candidate.content.parts[0]) {
                console.error("AI Content Malformed:", candidate);
                throw new Error("AI returned invalid content structure.");
            }

            const text = candidate.content.parts[0].text;

            // Clean up code blocks if present (just in case)
            const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();

            return JSON.parse(cleanText);

        } catch (e) {
            console.error("AI Service Exception:", e);
        }
    },

    /**
     * Calls Gemini to RESTRUCTURE items into a brand new hierarchy.
     * Ignores existing folders (mostly).
     */
    restructureWithAI: async (links, apiKey, hints = "") => {
        const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

        const itemsList = links.map(l => `ID: ${l.id} | Title: ${l.title}`).join('\n');

        const hintInstruction = hints ? `\nUSER GUIDANCE: The user has provided specific hints: "${hints}". Use this input to infer the desired **VIBE** and **LEVEL OF SPECIFICITY**. It may contain specific categories to use, or simply serve as an example of the granularity they want. Adjust your categorization strategy to align with this.` : '';

        const prompt = `
You are a Lazy Librarian.
The current library is a mess. You need to stack these books (bookmarks) into new piles (folders).
You do not care about the content. You are non-judgmental.
Group them by simple keywords or broad topics.
${hintInstruction}

Rules:
1. Ignore current folders. Start fresh.
2. Group items into Logical Categories and Subcategories.
   - Example: "Dev/Web", "Dev/Python", "Lifestyle/Cooking", "Lifestyle/Fitness".
3. Use Breadcrumb Syntax for the new structure:
   - "Category > Subcategory"
   - "Gaming > RPG > Final Fantasy"
4. Return strict JSON: Dictionary { "BookmarkID": "New Path" }.

Bookmarks:
${itemsList}

JSON Output:
`;

        // Debug Log
        console.group("🏗️ AI Restructure Debug");
        console.log("Items:", itemsList);
        console.groupEnd();

        try {
            const response = await fetch(API_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { response_mime_type: "application/json" },
                    safetySettings: [
                        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
                    ]
                })
            });

            if (!response.ok) throw new Error("AI Request Failed");
            const data = await response.json();
            const text = data.candidates[0].content.parts[0].text;
            const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
            return JSON.parse(cleanText);

        } catch (e) {
            console.error(e);
            throw e;
        }
    }
};

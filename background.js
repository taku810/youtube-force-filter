console.log("[Background] Service worker starting/started."); // 開始ログ

// --- Gemini API 設定 ---
const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent";

// --- APIキー取得関数 ---
async function getApiKey() {
    console.log("[Background] Attempting to get API key from chrome.storage.local."); // 取得試行ログ
    try {
        const result = await chrome.storage.local.get(['geminiApiKey']);
        if (result.geminiApiKey) {
            console.log("[Background] API Key found in storage."); // 発見ログ
            return result.geminiApiKey;
        } else {
            console.warn("[Background] API Key NOT found in storage."); // 未発見ログ
            return null;
        }
    } catch (error) {
        console.error("[Background] Error retrieving API key from storage:", error); // 取得エラーログ
        return null;
    }
}

// --- メッセージリスナー ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log("[Background] Received message:", request); // メッセージ受信ログ

    if (request.action === "classifyVideo") {
        console.log(`[Background] Action 'classifyVideo' received for title: "${request.title}"`);
        const videoTitle = request.title;

        // 非同期処理を実行
        (async () => {
            try {
                const apiKey = await getApiKey(); // 内部でログ出力あり
                if (!apiKey) {
                     console.error("[Background] API Key is missing. Cannot call API.");
                     throw new Error("APIキーが設定されていません。拡張機能のアイコンをクリックして設定してください。");
                }

                console.log("[Background] Calling callGeminiApi function..."); // API関数呼び出し前ログ
                const genre = await callGeminiApi(apiKey, videoTitle);
                console.log(`[Background] callGeminiApi returned genre: "${genre}"`); // API関数呼び出し後ログ

                console.log("[Background] Sending response back to content script:", { genre: genre }); // 応答送信前ログ
                sendResponse({ genre: genre });

            } catch (error) {
                console.error("[Background] Error during classification process:", error); // 処理エラーログ
                console.log("[Background] Sending error response back to content script:", { error: error.message }); // エラー応答送信前ログ
                // エラーオブジェクト全体を送ると複雑になる場合があるので、メッセージだけ送る
                sendResponse({ error: error.message || "不明なバックグラウンドエラー" });
            }
        })();

        return true; // 非同期応答を示す
    }

    // classifyVideo 以外のアクションが来た場合 (今回は該当しないはず)
    console.warn("[Background] Received message with unknown action:", request.action);
    return false; // このリスナーでは処理しないことを示す
});

// --- Gemini API 呼び出し関数 ---
async function callGeminiApi(apiKey, title) {
    // 適切なプロンプトに改善
    const prompt = `以下のYouTube動画のタイトルを分析し、最も関連性の高い主要なジャンルを一つだけ、リストから選んで日本語で答えてください。リストにない場合は最も近いと思われるものを答えてください。正確な判定と、単語一つだけの回答が重要です。

リスト: 仕事、勉強、プログラミング、起業、エンタメ、音楽、ゲーム、ニュース、スポーツ、料理、旅行、動物、ライフハック、政治、経済、科学、歴史、その他

タイトル: ${title}

ジャンル:`;
    const requestUrl = `${GEMINI_API_BASE_URL}?key=${apiKey}`;
    console.log(`[Background] Preparing to call Gemini API for title: "${title}"`); // API呼び出し準備ログ

    try {
        console.log("[Background] Fetching Gemini API:", requestUrl); // Fetch実行ログ
        const response = await fetch(requestUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.2, maxOutputTokens: 50 },
                safetySettings: [ /* ... 安全性設定 ... */ ] // 省略
            }),
        });
        console.log(`[Background] Gemini API response status: ${response.status}`); // ステータスログ

        if (!response.ok) {
            let errorBodyText = "Could not read error body";
            try {
                errorBodyText = await response.text();
            } catch (e) { console.error("Error reading error body:", e); }
            console.error(`[Background] Gemini API Error Response Body: ${errorBodyText}`); // エラー内容ログ
            // エラーメッセージを改善
            const errorDetail = errorBodyText.length < 200 ? `: ${errorBodyText}` : ''; // 長すぎるエラー本文は省略
            throw new Error(`Gemini API request failed (HTTP ${response.status})${errorDetail}`);
        }

        const data = await response.json();
        console.log("[Background] Gemini API Raw Response Data:", JSON.stringify(data, null, 2)); // ★★★ APIの生応答は重要 ★★★

        // --- レスポンスからジャンル名を抽出 ---
        if (data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
            let extractedGenre = data.candidates[0].content.parts[0].text.trim();
            // より厳密な抽出（単一のジャンル名のみを取得）
            extractedGenre = extractedGenre.split(/[\s、。\n（(]/)[0].replace(/[「」]/g, '');
            console.log(`[Background] Extracted genre: "${extractedGenre}"`); // 抽出成功ログ
            
            // 有効なジャンルのリスト
            const validGenres = ['仕事', '勉強', 'プログラミング', '起業', 'エンタメ', '音楽', 'ゲーム', 'ニュース', 'スポーツ', '料理', '旅行', '動物', 'ライフハック', '政治', '経済', '科学', '歴史', 'その他'];
            
            // 抽出されたジャンルが有効なリストにあるか確認
            if (!validGenres.includes(extractedGenre)) {
                console.warn(`[Background] Extracted genre "${extractedGenre}" is not in the valid list, falling back to 'その他'`);
                return "その他";
            }
            
            if (!extractedGenre || extractedGenre.length > 15) {
                console.warn(`[Background] Extracted genre ("${extractedGenre}") seems invalid, falling back to 'その他'`);
                return "その他";
            }
            return extractedGenre;
        } else if (data.promptFeedback?.blockReason) {
            const reason = data.promptFeedback.blockReason;
            console.warn(`[Background] Gemini API blocked the prompt. Reason: ${reason}`); // ブロック理由ログ
            throw new Error(`コンテンツが安全でないと判断されました (${reason})。`);
        } else {
            console.error("[Background] Could not extract genre from Gemini response structure."); // 抽出失敗ログ
            throw new Error("Geminiからの応答形式が不正か、ジャンルを抽出できませんでした。");
        }

    } catch (error) {
        console.error('[Background] Error during Gemini API call function:', error); // API関数内エラー
        throw error; // エラーを呼び出し元（メッセージリスナー）に再スロー
    }
}

// --- 拡張機能インストール/アップデート時の処理 ---
chrome.runtime.onInstalled.addListener((details) => {
    console.log(`[Background] onInstalled event triggered. Reason: ${details.reason}`); // インストールイベントログ
    if (details.reason === "install") {
        chrome.storage.local.get(['geminiApiKey'], (result) => {
            if (!result.geminiApiKey) {
                 console.log("[Background] API Key is not set on install.");
            }
        });
    }
});

console.log("[Background] Service worker event listeners attached."); // リスナー設定完了ログ
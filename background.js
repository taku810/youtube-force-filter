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
    // 適切なプロンプトに改善：より明確な指示と一貫した回答を促す
    const prompt = `あなたは動画ジャンル分類の専門家です。以下のYouTube動画のタイトルを分析し、最も関連性の高い主要なジャンルを一つだけ、リストから選んで回答してください。

リスト: 仕事、勉強、プログラミング、起業、エンタメ、音楽、ゲーム、ニュース、スポーツ、料理、旅行、動物、ライフハック、政治、経済、科学、歴史、その他

タイトル: ${title}

注意点:
- リストにある単語一つだけを回答してください
- 説明や理由は不要です
- リストにない場合は「その他」を選んでください
- 確信が持てない場合は「その他」を選んでください

回答:`;
    const requestUrl = `${GEMINI_API_BASE_URL}?key=${apiKey}`;
    console.log(`[Background] Preparing to call Gemini API for title: "${title}"`);

    try {
        // リトライメカニズムの実装
        const maxRetries = 2;
        let retryCount = 0;
        let lastError = null;

        while (retryCount <= maxRetries) {
            try {
                console.log(`[Background] Fetching Gemini API (attempt ${retryCount + 1}/${maxRetries + 1}):`, requestUrl);
                const response = await fetch(requestUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                        generationConfig: { 
                            temperature: 0.1, // より決定論的な回答のために温度を下げる
                            maxOutputTokens: 10, // 短い回答のみ必要
                            topK: 1,
                            topP: 0.95
                        },
                        safetySettings: [
                            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
                            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
                            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
                            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" }
                        ]
                    }),
                    // タイムアウト設定
                    signal: AbortSignal.timeout(10000) // 10秒でタイムアウト
                });
                
                console.log(`[Background] Gemini API response status: ${response.status}`);

                if (!response.ok) {
                    let errorBodyText = "Could not read error body";
                    try {
                        errorBodyText = await response.text();
                    } catch (e) { console.error("Error reading error body:", e); }
                    
                    console.error(`[Background] Gemini API Error Response Body: ${errorBodyText}`);
                    
                    // 429（レート制限）または5xxエラーの場合はリトライ
                    if (response.status === 429 || response.status >= 500) {
                        lastError = new Error(`Gemini API request failed (HTTP ${response.status}): ${errorBodyText}`);
                        // リトライ前に少し待機（バックオフ）
                        await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
                        retryCount++;
                        continue;
                    }
                    
                    // その他のHTTPエラーはリトライしない
                    throw new Error(`Gemini API request failed (HTTP ${response.status}): ${errorBodyText}`);
                }

                const data = await response.json();
                console.log("[Background] Gemini API Raw Response Data:", JSON.stringify(data, null, 2));

                // --- レスポンスからジャンル名を抽出 ---
                if (data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
                    let extractedGenre = data.candidates[0].content.parts[0].text.trim();
                    // より厳密な抽出（単一のジャンル名のみを取得）
                    extractedGenre = extractedGenre
                        .split(/[\s、。\n（(]/)[0]  // 最初の空白や句読点で分割し最初の部分を取得
                        .replace(/[「」『』]/g, '') // 引用符を削除
                        .replace(/[:：]/g, '')     // コロンを削除
                        .trim();                   // 余分な空白を削除
                    
                    console.log(`[Background] Extracted genre: "${extractedGenre}"`);
                    
                    // 有効なジャンルのリスト
                    const validGenres = ['仕事', '勉強', 'プログラミング', '起業', 'エンタメ', '音楽', 'ゲーム', 'ニュース', 'スポーツ', '料理', '旅行', '動物', 'ライフハック', '政治', '経済', '科学', '歴史', 'その他'];
                    
                    // 抽出されたジャンルが有効なリストにあるか確認し、大文字小文字や部分一致も考慮
                    const matchedGenre = validGenres.find(genre => 
                        extractedGenre === genre || 
                        extractedGenre.toLowerCase() === genre.toLowerCase()
                    );
                    
                    if (matchedGenre) {
                        console.log(`[Background] Matched to valid genre: "${matchedGenre}"`);
                        return matchedGenre; // 正確に一致したジャンルを返す
                    }
                    
                    // 部分一致の場合（曖昧な場合）
                    const partialMatch = validGenres.find(genre => 
                        extractedGenre.includes(genre) || genre.includes(extractedGenre)
                    );
                    
                    if (partialMatch) {
                        console.log(`[Background] Partial match to genre: "${partialMatch}"`);
                        return partialMatch;
                    }
                    
                    console.warn(`[Background] Extracted genre "${extractedGenre}" is not in the valid list, falling back to 'その他'`);
                    return "その他";
                } else if (data.promptFeedback?.blockReason) {
                    const reason = data.promptFeedback.blockReason;
                    console.warn(`[Background] Gemini API blocked the prompt. Reason: ${reason}`);
                    throw new Error(`コンテンツが安全でないと判断されました (${reason})。別の動画を試してください。`);
                } else {
                    console.error("[Background] Could not extract genre from Gemini response structure.");
                    throw new Error("Geminiからの応答形式が不正か、ジャンルを抽出できませんでした。");
                }
                
            } catch (error) {
                // リトライ可能なエラー（ネットワークエラーなど）
                if (error.name === 'AbortError' || error.name === 'TypeError' || error.name === 'NetworkError' || 
                    error.message.includes('network') || error.message.includes('timeout')) {
                    console.warn(`[Background] Retriable error (attempt ${retryCount + 1}/${maxRetries + 1}):`, error);
                    lastError = error;
                    // リトライ前に少し待機（バックオフ）
                    await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
                    retryCount++;
                } else {
                    // リトライ不可能なエラー
                    throw error;
                }
            }
        }
        
        // 最大リトライ回数を超えた場合、最後のエラーをスロー
        if (lastError) {
            console.error('[Background] Max retries exceeded with error:', lastError);
            throw new Error(`APIの呼び出しに失敗しました (${maxRetries + 1}回試行)。しばらく待ってから再試行してください。`);
        }
        
    } catch (error) {
        console.error('[Background] Error during Gemini API call function:', error);
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
document.addEventListener('DOMContentLoaded', () => {
    const apiKeyInput = document.getElementById('apiKey');
    const saveButton = document.getElementById('saveButton');
    const statusDiv = document.getElementById('status');
    const filterEnabledToggle = document.getElementById('filterEnabled');
    const genreCheckboxes = document.querySelectorAll('.genre-checkbox input[type="checkbox"]');

    // --- 保存されている設定を読み込んで表示 ---
    chrome.storage.local.get(['geminiApiKey', 'filterEnabled', 'blockedGenres'], (result) => {
        // APIキーの読み込み
        if (result.geminiApiKey) {
            apiKeyInput.value = result.geminiApiKey;
            console.log("API Key loaded into popup.");
        } else {
            console.log("No API Key found in storage.");
        }

        // フィルター有効/無効の設定読み込み
        if (result.filterEnabled !== undefined) {
            filterEnabledToggle.checked = result.filterEnabled;
            console.log(`Filter enabled setting loaded: ${result.filterEnabled}`);
        } else {
            // デフォルトでフィルターは有効
            filterEnabledToggle.checked = true;
            console.log("No filter enabled setting found, defaulting to enabled.");
        }

        // ブロックするジャンルの設定読み込み
        if (result.blockedGenres && Array.isArray(result.blockedGenres)) {
            console.log(`Blocked genres loaded: ${result.blockedGenres.join(', ')}`);
            // 各チェックボックスの状態を設定
            genreCheckboxes.forEach(checkbox => {
                checkbox.checked = result.blockedGenres.includes(checkbox.value);
            });
        } else {
            // デフォルトでブロックするジャンル（音楽とエンタメは除外）
            const defaultBlockedGenres = ['ゲーム', 'スポーツ', '料理', '旅行', '動物', 'ライフハック', '政治', '経済', '科学', '歴史', 'その他'];
            genreCheckboxes.forEach(checkbox => {
                checkbox.checked = defaultBlockedGenres.includes(checkbox.value);
            });
            console.log(`No blocked genres found, using defaults: ${defaultBlockedGenres.join(', ')}`);
        }
    });

    // --- フィルター有効/無効トグルのイベント ---
    filterEnabledToggle.addEventListener('change', () => {
        const isEnabled = filterEnabledToggle.checked;
        console.log(`Filter enabled changed to: ${isEnabled}`);
        
        chrome.storage.local.set({ filterEnabled: isEnabled }, () => {
            showStatus(`フィルターが${isEnabled ? '有効' : '無効'}になりました`, 'success');
        });
    });

    // --- ジャンル選択チェックボックスのイベント ---
    genreCheckboxes.forEach(checkbox => {
        checkbox.addEventListener('change', () => {
            saveBlockedGenres();
        });
    });

    // --- ブロックするジャンルを保存する関数 ---
    function saveBlockedGenres() {
        const blockedGenres = Array.from(genreCheckboxes)
            .filter(checkbox => checkbox.checked)
            .map(checkbox => checkbox.value);
        
        console.log(`Saving blocked genres: ${blockedGenres.join(', ')}`);
        
        chrome.storage.local.set({ blockedGenres: blockedGenres }, () => {
            showStatus('ブロックするジャンルを保存しました', 'success');
        });
    }

    // --- 保存ボタンのクリックイベント ---
    saveButton.addEventListener('click', () => {
        const apiKey = apiKeyInput.value.trim();
        
        if (apiKey) {
            // --- APIキーを chrome.storage.local に保存 ---
            chrome.storage.local.set({ geminiApiKey: apiKey }, () => {
                // 保存成功時の処理
                console.log("API Key saved successfully.");
                showStatus('APIキーを保存しました', 'success');
            });
        } else {
            // --- APIキーが空の場合 ---
            console.log("API Key input is empty.");
            showStatus('APIキーを入力してください', 'error');
        }
    });

    // --- ステータスメッセージを表示する関数 ---
    function showStatus(message, type) {
        statusDiv.textContent = message;
        statusDiv.className = type; // success または error
        
        // 一定時間後にメッセージを消す
        setTimeout(() => {
            statusDiv.textContent = '';
            statusDiv.className = '';
        }, 3000);
    }
});
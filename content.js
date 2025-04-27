console.log("[Content] Script loaded and executed.");

// --- 設定 ---
let FILTER_ENABLED = true; // デフォルトで有効、後で設定から読み込む
let BLOCKED_GENRES = []; // ブロックするジャンルのリスト、後で設定から読み込む
const VIDEO_LINK_SELECTOR = 'a#thumbnail[href*="/watch?v="], a#video-title-link[href*="/watch?v="]'; // サムネイルとタイトルリンクを対象
const VIDEO_CONTAINER_SELECTORS = [ // 動画全体を囲むコンテナ要素の可能性のあるセレクタ
    'ytd-rich-item-renderer',
    'ytd-grid-video-renderer',
    'ytd-compact-video-renderer',
    'ytd-video-renderer',
    'ytd-playlist-panel-video-renderer',
    '#dismissible'
];

// --- 設定の読み込み ---
function loadSettings() {
    chrome.storage.local.get(['filterEnabled', 'blockedGenres'], (result) => {
        if (result.filterEnabled !== undefined) {
            FILTER_ENABLED = result.filterEnabled;
            console.log(`[Content] Filter enabled setting loaded: ${FILTER_ENABLED}`);
        }
        
        if (result.blockedGenres && Array.isArray(result.blockedGenres)) {
            BLOCKED_GENRES = result.blockedGenres;
            console.log(`[Content] Blocked genres loaded: ${BLOCKED_GENRES.join(', ')}`);
        }
    });
}

// 初期設定の読み込み
loadSettings();

// 設定変更を監視
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
        if (changes.filterEnabled) {
            FILTER_ENABLED = changes.filterEnabled.newValue;
            console.log(`[Content] Filter enabled changed to: ${FILTER_ENABLED}`);
        }
        
        if (changes.blockedGenres) {
            BLOCKED_GENRES = changes.blockedGenres.newValue;
            console.log(`[Content] Blocked genres changed to: ${BLOCKED_GENRES.join(', ')}`);
        }
    }
});

// --- DOM操作関数 ---

/** 動画コンテナを見つける */
function findVideoContainer(element) {
    for (const selector of VIDEO_CONTAINER_SELECTORS) {
        const container = element.closest(selector);
        if (container) return container;
    }
    console.warn("[Content] Could not find a known video container for:", element);
    // 見つからない場合、リンク要素の親を返す（不確実だが、何かしら返す）
    return element.parentElement;
}

/** 判定中表示を追加 */
function showProcessingIndicator(container) {
    hideProcessingIndicator(container); // 既存があれば削除
    const overlay = document.createElement('div');
    overlay.className = 'youtube-focus-filter-overlay'; // CSSクラスを適用 (content_styles.cssで定義)
    overlay.textContent = '判定中...';
    // コンテナに relative position がないと overlay がずれる可能性
    if (container && getComputedStyle(container).position === 'static') {
        container.style.position = 'relative';
    }
    if (container) {
        container.appendChild(overlay);
        console.log("[Content] Showing processing indicator.");
    } else {
        console.error("[Content] Cannot show indicator: container not found.");
    }
}

/** 判定中表示を削除 */
function hideProcessingIndicator(container) {
    if (!container) return;
    const overlay = container.querySelector('.youtube-focus-filter-overlay');
    if (overlay) {
        overlay.remove();
        console.log("[Content] Hiding processing indicator.");
    }
}

/** 動画をブロック状態にする */
function blockVideo(container, genre) {
    if (!container) return;
    hideProcessingIndicator(container); // 念のため判定中表示を消す
    container.classList.add('youtube-focus-filter-blocked-container'); // ブロック用クラス適用 (content_styles.cssで定義)

    // ブロック理由表示 (既存のがあれば更新、なければ作成)
    let blockedIndicator = container.querySelector('.youtube-focus-filter-blocked-indicator');
    if (!blockedIndicator) {
        blockedIndicator = document.createElement('div');
        blockedIndicator.className = 'youtube-focus-filter-blocked-indicator'; // CSSクラス適用
        container.appendChild(blockedIndicator);
    }
    blockedIndicator.textContent = `ブロック (${genre})`;
    console.log(`[Content] Video blocked. Genre: ${genre}`);
}

/** ブロック状態を解除（もし必要なら） */
function unblockVideo(container) {
    if (!container) return;
    container.classList.remove('youtube-focus-filter-blocked-container');
    const indicator = container.querySelector('.youtube-focus-filter-blocked-indicator');
    if (indicator) {
        indicator.remove();
    }
    console.log("[Content] Video unblocked (if it was blocked).");
}

// --- タイトル抽出関数 ---

/** aria-label や alt 属性からタイトル部分を整形抽出 */
function cleanTitleFromMetadata(rawText) {
    // (この関数の内容は変更なし)
    if (!rawText) return '';
    let title = rawText;
    // " by [作者名]" や " 作成者: [作者名]" を削除 (日本語・英語対応)
    title = title.replace(/ by .+$/, '').replace(/ 作成者: .+$/, '');
    // 再生回数や時間情報を削除 (より多くのパターンに対応)
    title = title.replace(/ [\d,]+ 回視聴 \d+ (時間|日前|週間前|か月前|年前)/, '');
    title = title.replace(/ [\d,]+ views \d+ (hour|day|week|month|year)s? ago/, '');
    title = title.replace(/ \d+ (minutes?|seconds?).*/, ''); // 時間のみの情報も削除
    title = title.replace(/ 再生時間: \d+:\d+$/, ''); // "再生時間: M:SS" 形式
    // 先頭・末尾の記号を除去
    title = title.replace(/^[【\[『「]/, '').replace(/[」』\]】]$/, '');
    // 区切り文字 (ハイフン、スラッシュ) で分割し最初の部分を採用
    title = title.split(/ [-–] /)[0].split(' / ')[0];
    title = title.trim();
    // 無効なタイトルを除外
    if (title.length > 1 && !title.match(/^\d+$/) && !title.startsWith("再生リスト") && !title.startsWith("チャンネルにアクセス") && !title.includes("非表示にする") && !title.includes("メンバーになる") && !title.includes("ライブ配信") && !title.includes("プレミア公開")) {
        return title;
    } else {
        console.log(`[Content] Cleaned title ("${title}") was rejected as invalid.`);
        return '';
    }
}

/** 動画タイトルを取得する非同期関数 */
async function getVideoTitle(linkElement, clickTarget) {
    let videoTitle = '';
    let foundTitle = false;
    const isThumbnailClick = clickTarget && clickTarget.tagName === 'IMG'; // サムネイル画像そのものがクリックされたか
    const isTitleLinkClick = linkElement && linkElement.id === 'video-title-link'; // タイトルリンク自体がクリックされたか

    console.log(`[Content] Attempting to extract video title... ThumbnailClick: ${isThumbnailClick}, TitleLinkClick: ${isTitleLinkClick}`);

    // 優先順位の高いソースから試す
    const titleSources = [
        { method: 'querySelector', selector: '#video-title', attribute: 'textContent', source: 'Inner #video-title' },
        { method: 'querySelector', selector: '#video-title > yt-formatted-string', attribute: 'textContent', source: 'Inner #video-title > yt-formatted-string' },
        { method: 'closest', selector: '[aria-label]', attribute: 'aria-label', source: 'Closest aria-label', needsCleaning: true },
        { method: 'querySelector', selector: 'img#img', attribute: 'alt', source: 'Inner img alt', needsCleaning: true }
    ];

    // 1. タイトルリンクがクリックされた場合、その中の #video-title を最優先
    if (isTitleLinkClick) {
        const titleElement = linkElement.querySelector('#video-title');
        if (titleElement && titleElement.textContent?.trim()) {
            videoTitle = titleElement.textContent.trim();
            foundTitle = true;
            console.log(`[Content] Title extracted from clicked title link's inner #video-title: "${videoTitle}"`);
        }
    }

    // 2. サムネイルがクリックされた場合、親コンテナの #video-title を試す
    if (!foundTitle && isThumbnailClick) {
        const parentContainer = findVideoContainer(linkElement);
        if (parentContainer) {
            const titleElementInParent = parentContainer.querySelector('#video-title');
            if (titleElementInParent && titleElementInParent.textContent?.trim()) {
                videoTitle = titleElementInParent.textContent.trim();
                foundTitle = true;
                console.log(`[Content] Title extracted from parent container's #video-title for thumbnail click: "${videoTitle}"`);
            }
        }
    }

    // 3. 上記で見つからない場合、標準的な探索を実行
    if (!foundTitle) {
        console.log("[Content] Starting standard title source search...");
        for (const source of titleSources) {
            let element;
            let rawText = '';
            try {
                if (source.method === 'querySelector') {
                    element = linkElement.querySelector(source.selector);
                    if (element) rawText = element[source.attribute]?.trim();
                } else if (source.method === 'closest') {
                    // closest は linkElement 自身を含む親要素を探す
                    element = linkElement.closest(source.selector);
                    if (element) rawText = element.getAttribute(source.attribute)?.trim();
                }

                if (rawText) {
                    console.log(`[Content] Trying source "${source.source}": Found element, Raw text/attr: "${rawText}"`);
                    let potentialTitle = rawText;
                    if (source.needsCleaning) {
                        potentialTitle = cleanTitleFromMetadata(potentialTitle);
                        console.log(`[Content] Cleaned title candidate: "${potentialTitle}"`);
                    }
                    // 妥当性チェック (クリーニング後もチェック)
                    if (potentialTitle && potentialTitle.length > 1 && !potentialTitle.match(/^\d+$/) && !potentialTitle.startsWith("再生リスト") && !potentialTitle.startsWith("チャンネルにアクセス") && !potentialTitle.includes("非表示にする") && !potentialTitle.includes("メンバーになる") && !potentialTitle.includes("ライブ配信") && !potentialTitle.includes("プレミア公開")) {
                        videoTitle = potentialTitle;
                        foundTitle = true;
                        console.log(`[Content] Title extracted successfully using source "${source.source}": "${videoTitle}"`);
                        break; // 見つかったらループ終了
                    } else if (potentialTitle) {
                        console.log(`[Content] Potential title ("${potentialTitle}") from source "${source.source}" seems invalid, continuing...`);
                    }
                }
            } catch (e) {
                console.error(`[Content] Error while trying source "${source.source}":`, e);
            }
             if (foundTitle) break;
        }
    }

    // 最終確認
    if (!foundTitle) {
        console.warn("[Content] Could not extract video title reliably.");
        return "不明なタイトル";
    }
    console.log(`[Content] Final Extracted Title: "${videoTitle}"`);
    return videoTitle;
}

// --- イベントハンドラ ---
async function handleVideoClick(event) {
    const linkElement = event.currentTarget; // イベントがアタッチされた <a> 要素
    const clickTarget = event.target;        // 実際にクリックされた要素 (imgなど)
    console.log("[Content] handleVideoClick triggered for:", linkElement.href, "Clicked element:", clickTarget.tagName);

    // フィルターが無効の場合は、通常通り動画再生
    if (!FILTER_ENABLED) {
        console.log("[Content] Filter is disabled. Allowing navigation.");
        return; // イベントをキャンセルせず、通常の動作を許可
    }

    event.preventDefault(); // デフォルトのリンク遷移を阻止
    event.stopPropagation(); // イベントの伝播を阻止（他のリスナーに影響を与えないように）

    const videoContainer = findVideoContainer(linkElement); // 動画コンテナ取得

    // 既にブロックされているか、判定中なら処理中断
    if (videoContainer && videoContainer.classList.contains('youtube-focus-filter-blocked-container')) {
        console.log("[Content] Clicked on an already blocked video. Doing nothing.");
        return;
    }
    if (videoContainer && videoContainer.querySelector('.youtube-focus-filter-overlay')) {
        console.log("[Content] Clicked while already processing. Doing nothing.");
        return;
    }

    // 判定中表示
    showProcessingIndicator(videoContainer);

    // タイトル取得
    const videoTitle = await getVideoTitle(linkElement, clickTarget);

    if (videoTitle === "不明なタイトル") {
        hideProcessingIndicator(videoContainer);
        alert("動画タイトルを取得できませんでした。判定をスキップして再生します。");
        console.warn("[Content] Title extraction failed, allowing navigation.");
        window.location.href = linkElement.href; // タイトル不明時は遷移許可
        return;
    }

    // バックグラウンドに判定依頼
    try {
        console.log(`[Content] Sending message to background for title: "${videoTitle}"`);
        const response = await chrome.runtime.sendMessage({
            action: "classifyVideo",
            title: videoTitle
        });
        console.log("[Content] Received response from background:", response);

        hideProcessingIndicator(videoContainer); // 応答が来たので判定中表示を消す

        if (response && response.error) {
            console.error("[Content] Background script reported an error:", response.error);
            alert(`動画の判定中にエラーが発生しました:\n${response.error}`);
            // エラー時はデフォルトでブロックする挙動
            blockVideo(videoContainer, "エラー");
        } else if (response && response.genre) {
            const genre = response.genre;
            // ブロックするジャンルリストに含まれているか確認
            const shouldBlock = BLOCKED_GENRES.some(blockedGenre => 
                genre.toLowerCase().includes(blockedGenre.toLowerCase())
            );
            console.log(`[Content] Genre: "${genre}", Should Block: ${shouldBlock}`);

            if (!shouldBlock) {
                console.log("[Content] Genre is NOT blocked. Navigating...");
                unblockVideo(videoContainer); // ブロック表示を解除（あれば）
                window.location.href = linkElement.href; // ★ 許可して遷移
            } else {
                blockVideo(videoContainer, genre); // ブロック処理と理由表示
                // 必要であればアラートを出す
                // alert(`この動画のジャンル「${genre}」はブロックされています。`);
            }
        } else {
            console.error("[Content] Invalid response received from background:", response);
            alert("バックグラウンドから無効な応答を受け取りました。");
            blockVideo(videoContainer, "応答不正"); // 不正応答時もブロック
        }

    } catch (error) {
        hideProcessingIndicator(videoContainer); // エラー時も表示解除
        console.error('[Content] Error sending message or processing response:', error);
        alert(`処理中にエラーが発生しました:\n${error.message}`);
        blockVideo(videoContainer, "通信エラー"); // 通信エラー時もブロック
    }
}

// --- MutationObserver による動的リスナー設定 ---
const observedLinks = new WeakSet(); // 既にリスナーを設定した要素を追跡

function addClickListenerIfNotExists(linkElement) {
    if (!linkElement || observedLinks.has(linkElement) || !linkElement.matches(VIDEO_LINK_SELECTOR)) {
        // 要素がない、処理済み、またはセレクタにマッチしない場合は無視
        return;
    }
    console.log("[Content] Adding click listener to:", linkElement.href || linkElement.id);
    linkElement.addEventListener('click', handleVideoClick, true); // キャプチャーフェーズで設定
    observedLinks.add(linkElement); // 処理済みとしてマーク
}

const observerCallback = (mutationsList, observer) => {
    for (const mutation of mutationsList) {
        if (mutation.type === 'childList') {
            mutation.addedNodes.forEach(node => {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    // 追加されたノード自体が動画リンクかチェック
                    if (node.matches && node.matches(VIDEO_LINK_SELECTOR)) {
                        addClickListenerIfNotExists(node);
                    }
                    // 追加されたノードの子孫に動画リンクが含まれるかチェック
                    node.querySelectorAll(VIDEO_LINK_SELECTOR).forEach(addClickListenerIfNotExists);
                }
            });
        }
    }
};

// Observer インスタンスを作成
const observer = new MutationObserver(observerCallback);

// 監視を開始
observer.observe(document.body, {
    childList: true,
    subtree: true
});

// 初期読み込み時に存在する動画リンクにもリスナーを設定
document.querySelectorAll(VIDEO_LINK_SELECTOR).forEach(addClickListenerIfNotExists);

console.log("[Content] MutationObserver initialized and initial listeners added.");
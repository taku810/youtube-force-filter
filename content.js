console.log("[Content] Script loaded and executed.");

// --- 設定 ---
let FILTER_ENABLED = true; // デフォルトで有効、後で設定から読み込む
let BLOCKED_GENRES = []; // ブロックするジャンルのリスト、後で設定から読み込む
// サムネイルセレクタを改善：より多くのタイプのYouTube動画リンクに対応
const VIDEO_LINK_SELECTOR = 'a.ytd-thumbnail[href*="/watch?v="], a#thumbnail[href*="/watch?v="], a#video-title-link[href*="/watch?v="], a.ytd-thumbnail-overlay-toggle-button-renderer[href*="/watch?v="], a.yt-simple-endpoint[href*="/watch?v="]';
const VIDEO_CONTAINER_SELECTORS = [ // 動画全体を囲むコンテナ要素の可能性のあるセレクタ
    'ytd-rich-item-renderer',
    'ytd-grid-video-renderer',
    'ytd-compact-video-renderer',
    'ytd-video-renderer',
    'ytd-playlist-panel-video-renderer',
    'ytd-reel-item-renderer', // ショート動画に対応
    'ytd-compact-playlist-renderer', // プレイリストに対応
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
    if (!rawText) return '';
    let title = rawText;
    // " by [作者名]" や " 作成者: [作者名]" を削除 (日本語・英語対応)
    title = title.replace(/ by .+$/, '').replace(/ 作成者: .+$/, '');
    // 再生回数や時間情報を削除 (より多くのパターンに対応)
    title = title.replace(/ [\d,]+ 回視聴 \d+ (時間|分|秒|日前|週間前|か月前|年前)/, '');
    title = title.replace(/ [\d,]+ views \d+ (hour|minute|second|day|week|month|year)s? ago/, '');
    title = title.replace(/ \d+ (minutes?|seconds?).*/, ''); // 時間のみの情報も削除
    title = title.replace(/ 再生時間: \d+:\d+$/, ''); // "再生時間: M:SS" 形式
    // 先頭・末尾の記号を除去
    title = title.replace(/^[【\[『「]/, '').replace(/[」』\]】]$/, '');
    // 区切り文字 (ハイフン、スラッシュ) で分割し最初の部分を採用
    title = title.split(/ [-–] /)[0].split(' / ')[0];
    title = title.trim();
    // 無効なタイトルを除外
    if (title.length > 1 && 
        !title.match(/^\d+$/) && 
        !title.startsWith("再生リスト") && 
        !title.startsWith("チャンネルにアクセス") && 
        !title.includes("非表示にする") && 
        !title.includes("メンバーになる") && 
        !title.includes("ライブ配信") && 
        !title.includes("プレミア公開")) {
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
    const isThumbnailContainer = linkElement && linkElement.id === 'thumbnail'; // サムネイルコンテナがクリックされたか

    console.log(`[Content] Attempting to extract video title... ThumbnailClick: ${isThumbnailClick}, TitleLinkClick: ${isTitleLinkClick}, ThumbnailContainer: ${isThumbnailContainer}`);

    // 親コンテナを取得（タイトル要素を見つけるため）
    const videoContainer = findVideoContainer(linkElement);

    // 優先順位の高いソースから試す
    const titleSources = [
        // 親コンテナのタイトル要素
        { method: 'container', selector: '#video-title', attribute: 'textContent', source: 'Container #video-title' },
        { method: 'container', selector: '#video-title > yt-formatted-string', attribute: 'textContent', source: 'Container #video-title > yt-formatted-string' },
        { method: 'container', selector: 'h3.ytd-grid-video-renderer', attribute: 'textContent', source: 'Container h3' },
        // リンク要素自体とその子要素
        { method: 'querySelector', selector: '#video-title', attribute: 'textContent', source: 'Inner #video-title' },
        { method: 'querySelector', selector: '#video-title > yt-formatted-string', attribute: 'textContent', source: 'Inner #video-title > yt-formatted-string' },
        // 余分な属性
        { method: 'closest', selector: '[aria-label]', attribute: 'aria-label', source: 'Closest aria-label', needsCleaning: true },
        { method: 'querySelector', selector: 'img#img', attribute: 'alt', source: 'Inner img alt', needsCleaning: true },
        // 親コンテナのアクセシビリティ情報
        { method: 'container', selector: '[title]', attribute: 'title', source: 'Container title attr' },
        { method: 'container', selector: '[aria-label]', attribute: 'aria-label', source: 'Container aria-label', needsCleaning: true }
    ];

    // 1. タイトルリンクがクリックされた場合、その中の #video-title を最優先
    if (isTitleLinkClick && !foundTitle) {
        const titleElement = linkElement.querySelector('#video-title');
        if (titleElement && titleElement.textContent?.trim()) {
            videoTitle = titleElement.textContent.trim();
            foundTitle = true;
            console.log(`[Content] Title extracted from clicked title link's inner #video-title: "${videoTitle}"`);
        }
    }

    // 2. サムネイルがクリックされた場合、親コンテナの #video-title を試す
    if (!foundTitle && (isThumbnailClick || isThumbnailContainer)) {
        if (videoContainer) {
            // IDベースのセレクタ
            const titleSelectors = [
                '#video-title', 
                'h3 a#video-title-link', 
                'a#video-title', 
                '.ytd-rich-grid-media #video-title'
            ];
            
            for (const selector of titleSelectors) {
                const titleElement = videoContainer.querySelector(selector);
                if (titleElement && titleElement.textContent?.trim()) {
                    videoTitle = titleElement.textContent.trim();
                    foundTitle = true;
                    console.log(`[Content] Title extracted from parent container using selector ${selector}: "${videoTitle}"`);
                    break;
                }
            }
        }
    }

    // 3. 上記で見つからない場合、標準的な探索を実行
    if (!foundTitle) {
        console.log("[Content] Starting standard title source search...");
        for (const source of titleSources) {
            if (foundTitle) break;

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
                } else if (source.method === 'container' && videoContainer) {
                    // コンテナ内の要素を検索
                    element = videoContainer.querySelector(source.selector);
                    if (element) {
                        if (source.attribute === 'textContent') {
                            rawText = element[source.attribute]?.trim();
                        } else {
                            rawText = element.getAttribute(source.attribute)?.trim();
                        }
                    }
                }

                if (rawText) {
                    console.log(`[Content] Trying source "${source.source}": Found element, Raw text/attr: "${rawText}"`);
                    let potentialTitle = rawText;
                    
                    if (source.needsCleaning) {
                        potentialTitle = cleanTitleFromMetadata(potentialTitle);
                        console.log(`[Content] Cleaned title candidate: "${potentialTitle}"`);
                    }
                    
                    // 妥当性チェック (クリーニング後もチェック)
                    if (potentialTitle && 
                        potentialTitle.length > 1 && 
                        !potentialTitle.match(/^\d+$/) && 
                        !potentialTitle.startsWith("再生リスト") && 
                        !potentialTitle.startsWith("チャンネルにアクセス") && 
                        !potentialTitle.includes("非表示にする") && 
                        !potentialTitle.includes("メンバーになる") && 
                        !potentialTitle.includes("ライブ配信") && 
                        !potentialTitle.includes("プレミア公開")) {
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
        }
    }

    // 4. 最後の手段: hrefからビデオIDを抽出し、そのIDをタイトルとして使用
    if (!foundTitle && linkElement && linkElement.href) {
        try {
            const videoIdMatch = linkElement.href.match(/[?&]v=([^&]+)/);
            if (videoIdMatch && videoIdMatch[1]) {
                const videoId = videoIdMatch[1];
                videoTitle = `動画ID: ${videoId}`;
                foundTitle = true;
                console.log(`[Content] Using video ID as fallback title: "${videoTitle}"`);
            }
        } catch (e) {
            console.error('[Content] Error extracting video ID:', e);
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

/**
 * 代替タイトル抽出方法を試みる
 */
async function tryAlternativeTitleExtraction(linkElement, videoContainer) {
    try {
        // 方法1: DOMツリーを上下に探索
        let title = "";
        
        // コンテナ内のすべてのテキストノードを探索
        if (videoContainer) {
            const textNodes = [];
            const walker = document.createTreeWalker(
                videoContainer,
                NodeFilter.SHOW_TEXT,
                null,
                false
            );
            
            while (walker.nextNode()) {
                const text = walker.currentNode.textContent.trim();
                if (text && text.length > 5 && text.length < 150) {
                    textNodes.push(text);
                }
            }
            
            // 最も可能性の高い（長い）テキストを選択
            if (textNodes.length > 0) {
                textNodes.sort((a, b) => {
                    // 優先順位: 長さ（短すぎず長すぎない）
                    const aScore = a.length > 10 && a.length < 100 ? a.length : 0;
                    const bScore = b.length > 10 && b.length < 100 ? b.length : 0;
                    return bScore - aScore;
                });
                title = textNodes[0];
                console.log("[Content] Alternative method 1: Found potential title from text nodes:", title);
            }
        }
        
        // 方法2: aria-label属性を持つ要素を探索（階層構造に関係なく）
        if (!title && videoContainer) {
            const ariaElements = videoContainer.querySelectorAll('[aria-label]');
            for (const el of ariaElements) {
                const ariaText = el.getAttribute('aria-label');
                if (ariaText && ariaText.length > 10 && ariaText.length < 200) {
                    title = cleanTitleFromMetadata(ariaText);
                    console.log("[Content] Alternative method 2: Found potential title from aria-label:", title);
                    break;
                }
            }
        }
        
        // 方法3: YouTubeの詳細なDOM構造を使用
        if (!title) {
            // トップレベルのグリッド要素からタイトルを探す
            const titleSelectors = [
                'ytd-rich-grid-media #video-title',
                'ytd-compact-video-renderer #video-title',
                'ytd-video-renderer #video-title',
                'h3 a#video-title-link',
                '#meta-contents #title h1 yt-formatted-string',
                '#meta-contents #title h1',
                'h1.title yt-formatted-string',
                // より広い範囲でタイトルを探す
                '.title-text',
                '.title.ytd-video-primary-info-renderer',
                'yt-formatted-string.ytd-video-renderer'
            ];
            
            for (const selector of titleSelectors) {
                const elements = document.querySelectorAll(selector);
                for (const el of elements) {
                    // リンク要素に近い要素を優先
                    if (el.textContent && el.textContent.trim()) {
                        title = el.textContent.trim();
                        console.log("[Content] Alternative method 3: Found title using selector", selector, ":", title);
                        break;
                    }
                }
                if (title) break;
            }
        }
        
        // 方法4: 最も広範なDOM探索 (YouTubeの動的変更に対応)
        if (!title) {
            // 親要素からの相対位置で一般的なタイトル領域をチェック
            if (linkElement.parentElement && linkElement.parentElement.parentElement) {
                const parent = linkElement.parentElement.parentElement;
                
                // 隣接する兄弟要素を探す
                const siblings = Array.from(parent.children || []);
                for (const sibling of siblings) {
                    if (sibling !== linkElement.parentElement && 
                        sibling.textContent && 
                        sibling.textContent.trim().length > 10 && 
                        sibling.textContent.trim().length < 150) {
                        title = sibling.textContent.trim();
                        console.log("[Content] Alternative method 4: Found title from sibling:", title);
                        break;
                    }
                }
                
                // まだ見つからない場合は、親の親の子を探す
                if (!title && parent.parentElement) {
                    const parentSiblings = Array.from(parent.parentElement.children || []);
                    for (const sibling of parentSiblings) {
                        if (sibling !== parent && 
                            sibling.textContent && 
                            sibling.textContent.trim().length > 10 && 
                            sibling.textContent.trim().length < 150) {
                            title = sibling.textContent.trim();
                            console.log("[Content] Alternative method 4: Found title from parent's sibling:", title);
                            break;
                        }
                    }
                }
            }
        }

        // タイトルが見つかったら、不要なテキストを除去
        if (title) {
            // 余分な非表示文字や改行を削除
            title = title.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
            // URLや通知テキストを除去
            title = title.replace(/https?:\/\/\S+/g, '').trim();
            title = title.replace(/通知|チャンネル登録|View|Subscribe|メンバーシップ|会員限定/g, '').trim();
            
            console.log("[Content] Final alternative title:", title);
        }
        
        return title || "不明なタイトル";
    } catch (error) {
        console.error("[Content] Error in alternative title extraction:", error);
        return "不明なタイトル";
    }
}

// --- イベントハンドラ ---
async function handleVideoClick(event) {
    const linkElement = event.currentTarget; // イベントがアタッチされた <a> 要素
    const clickTarget = event.target;        // 実際にクリックされた要素 (imgなど)
    
    console.log("[Content] handleVideoClick triggered for:", linkElement.href, "Clicked element:", clickTarget.tagName);

    // 無効なURLは処理しない（安全対策）
    if (!linkElement.href || !linkElement.href.includes('/watch?v=')) {
        console.log("[Content] Not a valid video URL, allowing default navigation.");
        return; // 通常の遷移を許可
    }
    
    // フィルターが無効の場合は、通常通り動画再生
    if (!FILTER_ENABLED) {
        console.log("[Content] Filter is disabled. Allowing navigation.");
        return; // イベントをキャンセルせず、通常の動作を許可
    }

    // ここでイベントをキャンセル
    event.preventDefault(); // デフォルトのリンク遷移を阻止
    event.stopPropagation(); // イベントの伝播を阻止

    // YouTubeのSPA遷移を防止するための追加対策
    setTimeout(() => {
        if (window.location.href.includes('/watch?v=') && 
            !window.location.href.includes(getVideoId(linkElement.href))) {
            return; // 既に遷移した場合は何もしない
        }
    }, 50);

    const videoContainer = findVideoContainer(linkElement);

    // 処理状態チェック
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

    try {
        // タイトル取得 - 複数の取得戦略を実装
        let videoTitle = await getVideoTitle(linkElement, clickTarget);
        
        if (!videoTitle || videoTitle === "不明なタイトル") {
            console.warn("[Content] Primary title extraction failed, trying fallback methods");
            
            // フォールバック1: より積極的なタイトル検索
            videoTitle = await tryAlternativeTitleExtraction(linkElement, videoContainer);
            
            // フォールバック2: ビデオIDを使用
            if (!videoTitle || videoTitle === "不明なタイトル") {
                const videoId = getVideoId(linkElement.href);
                if (videoId) {
                    videoTitle = `動画ID: ${videoId}`;
                    console.log("[Content] Using video ID as last resort title:", videoTitle);
                } else {
                    // 完全に失敗した場合
                    hideProcessingIndicator(videoContainer);
                    const proceed = confirm("動画情報を取得できませんでした。判定をスキップして再生しますか？");
                    if (proceed) {
                        window.location.href = linkElement.href;
                    }
                    return;
                }
            }
        }

        // 有効なタイトルが取得できた場合、分類処理に進む
        processVideoClassification(videoContainer, linkElement, videoTitle);

    } catch (error) {
        hideProcessingIndicator(videoContainer);
        console.error('[Content] Error in video click handler:', error);
        const proceed = confirm(`処理中にエラーが発生しました:\n${error.message}\n\n判定をスキップして再生しますか？`);
        if (proceed) {
            window.location.href = linkElement.href;
        } else {
            blockVideo(videoContainer, "処理エラー");
        }
    }
}

/** 動画の分類処理を行う（分離して可読性向上） */
async function processVideoClassification(videoContainer, linkElement, videoTitle) {
    try {
        console.log(`[Content] Sending message to background for title: "${videoTitle}"`);
        
        // 処理の開始時刻を記録（タイムアウト検出用）
        const startTime = Date.now();
        
        // バックグラウンドスクリプトにメッセージを送信
        const response = await Promise.race([
            chrome.runtime.sendMessage({
                action: "classifyVideo",
                title: videoTitle
            }),
            // 15秒のタイムアウトを設定
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error("バックグラウンド処理がタイムアウトしました")), 15000)
            )
        ]);
        
        const processingTime = Date.now() - startTime;
        console.log(`[Content] Received response from background after ${processingTime}ms:`, response);

        hideProcessingIndicator(videoContainer); // 応答が来たので判定中表示を消す

        if (response && response.error) {
            console.error("[Content] Background script reported an error:", response.error);
            const proceed = confirm(`動画の判定中にエラーが発生しました:\n${response.error}\n\n判定をスキップして再生しますか？`);
            if (proceed) {
                window.location.href = linkElement.href;
            } else {
                blockVideo(videoContainer, "エラー");
            }
        } else if (response && response.genre) {
            const genre = response.genre;
            // ブロックするジャンルリストに含まれているか確認（大文字小文字を区別しない）
            const shouldBlock = BLOCKED_GENRES.some(blockedGenre => 
                genre.toLowerCase().includes(blockedGenre.toLowerCase())
            );
            console.log(`[Content] Genre: "${genre}", Should Block: ${shouldBlock}, Blocked Genres: [${BLOCKED_GENRES.join(', ')}]`);

            if (!shouldBlock) {
                console.log("[Content] Genre is NOT blocked. Navigating...");
                unblockVideo(videoContainer); // ブロック表示を解除（あれば）
                // 自分自身を呼び出す再帰を防ぐためにsetTimeout使用
                setTimeout(() => {
                    window.location.href = linkElement.href; // 許可して遷移
                }, 5);
            } else {
                blockVideo(videoContainer, genre); // ブロック処理と理由表示
            }
        } else {
            console.error("[Content] Invalid response received from background:", response);
            const proceed = confirm("バックグラウンドから無効な応答を受け取りました。判定をスキップして再生しますか？");
            if (proceed) {
                window.location.href = linkElement.href;
            } else {
                blockVideo(videoContainer, "応答不正"); // 不正応答時もブロック
            }
        }

    } catch (error) {
        hideProcessingIndicator(videoContainer); // エラー時も表示解除
        console.error('[Content] Error sending message or processing response:', error);
        
        const proceed = confirm(`処理中にエラーが発生しました:\n${error.message}\n\n判定をスキップして再生しますか？`);
        if (proceed) {
            window.location.href = linkElement.href;
        } else {
            blockVideo(videoContainer, "通信エラー"); // 通信エラー時もブロック
        }
    }
}

// --- MutationObserver による動的リスナー設定 ---
const observedLinks = new WeakSet(); // 既にリスナーを設定した要素を追跡

function addClickListenerIfNotExists(linkElement) {
    try {
        if (!linkElement || !linkElement.href || observedLinks.has(linkElement)) {
            // 要素がない、URLがない、処理済みの場合は無視
            return;
        }
        
        // セレクタにマッチするか厳密に確認（より包括的なチェック）
        if (linkElement.href.includes('/watch?v=')) {
            linkElement.addEventListener('click', handleVideoClick, { capture: true }); // キャプチャーフェーズで設定
            observedLinks.add(linkElement); // 処理済みとしてマーク
            console.log("[Content] Added click listener to video link:", linkElement.href || linkElement.id);
        }
    } catch (error) {
        console.error("[Content] Error adding click listener:", error);
    }
}

// すべての動画リンクを検索して登録する関数
function findAndAddListenersToAllVideoLinks() {
    console.log("[Content] Scanning for video links to add listeners...");
    
    try {
        // より多くのセレクタパターンを直接適用
        const selectors = [
            'a#thumbnail[href*="/watch?v="]',
            'a.ytd-thumbnail[href*="/watch?v="]',
            'a#video-title-link[href*="/watch?v="]',
            'a.ytd-thumbnail-overlay-toggle-button-renderer[href*="/watch?v="]',
            'a.yt-simple-endpoint[href*="/watch?v="]',
            // ホーム画面用
            'ytd-rich-grid-media a[href*="/watch?v="]',
            // 検索結果用
            'ytd-video-renderer a[href*="/watch?v="]',
            // 関連動画用
            'ytd-compact-video-renderer a[href*="/watch?v="]',
            // その他のパターン
            'a[href*="/watch?v="]'
        ];
        
        // 各セレクタパターンで検索
        let totalFound = 0;
        for (const selector of selectors) {
            const links = document.querySelectorAll(selector);
            totalFound += links.length;
            links.forEach(addClickListenerIfNotExists);
        }
        console.log(`[Content] Found and processed ${totalFound} video links`);
        
        // ヘッダーのホームアイコンやメニュー項目など、特定のナビゲーション要素へのイベント伝播を防止
        const navigationElements = document.querySelectorAll('ytd-topbar-menu-button-renderer, ytd-mini-guide-renderer a, ytd-guide-renderer a');
        navigationElements.forEach(elem => {
            if (!elem.dataset.filterHandlerAdded) {
                elem.addEventListener('click', (e) => {
                    // 通常の遷移を許可
                    console.log("[Content] Navigation element clicked, allowing default behavior");
                    elem.dataset.filterHandlerAdded = 'true';
                }, { capture: true });
            }
        });
        
    } catch (error) {
        console.error("[Content] Error while scanning for video links:", error);
    }
}

// MutationObserverのコールバック：動的に追加されるリンク要素を検出
const observerCallback = (mutationsList, observer) => {
    let shouldScanAllLinks = false;
    
    try {
        for (const mutation of mutationsList) {
            // 新しいノードが追加された場合
            if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                // 大規模なDOM変更を検出
                if (mutation.addedNodes.length > 5 || 
                    (mutation.target && (
                        mutation.target.id === 'contents' || 
                        mutation.target.id === 'items' ||
                        mutation.target.id === 'dismissible' ||
                        mutation.target.tagName === 'YTD-RICH-GRID-ROW' ||
                        mutation.target.classList.contains('ytd-rich-grid-renderer')
                    ))) {
                    shouldScanAllLinks = true;
                    continue; // 次のミューテーションをチェック
                }
                
                // 個別のノードをチェック
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        // 追加されたノード自体が動画リンクかチェック
                        if (node.tagName === 'A' && node.href && node.href.includes('/watch?v=')) {
                            addClickListenerIfNotExists(node);
                        }
                        // 追加されたノードの子孫に動画リンクが含まれるかチェック
                        if (node.querySelectorAll) {
                            node.querySelectorAll('a[href*="/watch?v="]').forEach(addClickListenerIfNotExists);
                        }
                    }
                });
            }
        }
        
        // 大規模なDOM変更があった場合は全リンクをスキャン
        if (shouldScanAllLinks) {
            console.log("[Content] Detected major DOM changes, scanning all links...");
            setTimeout(findAndAddListenersToAllVideoLinks, 100); // 少し遅延させてDOM更新を待つ
        }
    } catch (error) {
        console.error("[Content] Error in MutationObserver callback:", error);
    }
};

// Observer インスタンスを作成
const observer = new MutationObserver(observerCallback);

// YouTube特有のDOMイベントリスナー
function setupYouTubeSpecificListeners() {
    try {
        // ナビゲーション完了イベント（YouTubeがSPAなのでページ遷移時にリスナーの再設定が必要）
        document.addEventListener('yt-navigate-finish', function() {
            console.log("[Content] YouTube navigation detected, re-scanning for video links...");
            // 遷移後少し待ってからスキャン
            setTimeout(findAndAddListenersToAllVideoLinks, 500);
            // YouTubeのSPA遷移では、URLは変わってもDOM要素が一部再利用されるため、
            // 判定中表示やブロック表示が残る可能性があるので、それらをクリア
            document.querySelectorAll('.youtube-focus-filter-overlay, .youtube-focus-filter-blocked-indicator').forEach(el => el.remove());
            document.querySelectorAll('.youtube-focus-filter-blocked-container').forEach(el => el.classList.remove('youtube-focus-filter-blocked-container'));
        });
        
        // スクロールイベント（遅延スクロール時に新しい動画が読み込まれるため）
        let scrollTimeout;
        window.addEventListener('scroll', function() {
            clearTimeout(scrollTimeout);
            scrollTimeout = setTimeout(function() {
                console.log("[Content] Page scrolled, checking for new video links...");
                findAndAddListenersToAllVideoLinks();
            }, 500); // スクロール終了後500ms待ってからスキャン
        }, { passive: true });
        
        // YouTubeのURLハッシュ変更を監視（一部のSPA遷移では、yt-navigate-finishが発火しない場合がある）
        window.addEventListener('hashchange', function() {
            console.log("[Content] URL hash changed, re-scanning for video links...");
            setTimeout(findAndAddListenersToAllVideoLinks, 500);
        });
        
        // YouTube特有のカスタムイベントを監視
        document.addEventListener('yt-service-request-completed', function() {
            console.log("[Content] YouTube service request completed, checking for new links...");
            setTimeout(findAndAddListenersToAllVideoLinks, 300);
        });
        
        console.log("[Content] YouTube-specific event listeners setup complete");
    } catch (error) {
        console.error("[Content] Error setting up YouTube-specific listeners:", error);
    }
}

// 拡張機能の初期化
function initializeExtension() {
    console.log("[Content] Initializing extension...");
    
    try {
        // 監視を開始（DOM全体を監視）
        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
        
        // YouTube特有のイベントリスナーをセットアップ
        setupYouTubeSpecificListeners();
        
        // 初期読み込み時に存在する動画リンクにリスナーを設定
        findAndAddListenersToAllVideoLinks();
        
        // 万が一、リスナーの設定が失敗した場合のフォールバックとして、定期的なスキャンを設定
        setInterval(findAndAddListenersToAllVideoLinks, 3000);
        
        console.log("[Content] Extension initialization complete.");
    } catch (error) {
        console.error("[Content] Error during extension initialization:", error);
        // エラーリカバリ: 少し待ってから再試行
        setTimeout(initializeExtension, 2000);
    }
}

// DOMが完全に読み込まれてから初期化を実行
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeExtension);
} else {
    // DOMはすでに読み込み済み
    initializeExtension();
}
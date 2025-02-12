const vscode = require('vscode');
const axios = require('axios');
const cheerio = require('cheerio');
const TurndownService = require('turndown');
const qs = require('qs');
const express = require('express');

/**
 * asyncHandler: async 함수를 Express RequestHandler로 감싸 에러를 next로 전달합니다.
 */
function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Express 프록시 서버: 이미지 요청 시 올바른 헤더(Referer 등)를 추가하여 우회합니다.
 */
function startProxyServer(port = 3000) {
  const app = express();

  app.get(
    '/',
    asyncHandler(async (req, res) => {
      const targetUrl = req.query.url;
      if (!targetUrl) {
        return res.status(400).send('No url provided.');
      }
      try {
        const response = await axios.get(targetUrl, {
          responseType: 'arraybuffer',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Referer': 'https://gall.dcinside.com'
          }
        });
        res.set('Content-Type', response.headers['content-type']);
        res.send(response.data);
      } catch (err) {
        console.error('Proxy server error:', err.message);
        res.status(500).send('Error fetching image.');
      }
    })
  );

  const server = app.listen(port, 'localhost', () => {
    console.log(`Proxy server listening on http://localhost:${port}`);
  });
  return server;
}

/**
 * DcInsideContentProvider: Markdown 미리보기 전용 가상 문서의 내용을 관리합니다.
 */
class DcInsideContentProvider {
  constructor() {
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChange = this._onDidChange.event;
    this.content = '';
  }
  provideTextDocumentContent(uri) {
    return this.content;
  }
  updateContent(newContent) {
    this.content = newContent;
    this._onDidChange.fire(vscode.Uri.parse('dcinside:post'));
  }
}
const dcContentProvider = new DcInsideContentProvider();
vscode.workspace.registerTextDocumentContentProvider('dcinside', dcContentProvider);

/**
 * SearchItem: 사이드바 상단에 표시되는 "갤러리 검색" 버튼
 */
class SearchItem extends vscode.TreeItem {
  constructor() {
    super("갤러리 검색", vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon("search");
    // unified 명령어 호출
    this.command = {
      command: 'dcinsideCrawler.searchUnified',
      title: '갤러리 검색'
    };
    this.contextValue = 'searchButton';
  }
}

/**
 * RecommendSearchItem: 사이드바 상단에 표시되는 "개념글 검색" 버튼
 * (이 예제에서는 옵션 목록에 포함시키지 않고 생략할 수 있습니다.)
 */
// 만약 개념글 검색 버튼을 사용하지 않으려면 이 클래스와 관련 명령어는 삭제해도 무방합니다.

/**
 * NavigationItem: 페이지 이동 버튼 (이전/다음 페이지)
 */
class NavigationItem extends vscode.TreeItem {
  constructor(label, direction) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.direction = direction;
    this.command = {
      command: 'dcinsideCrawler.navigatePage',
      title: '페이지 이동',
      arguments: [this.direction]
    };
    this.iconPath = new vscode.ThemeIcon(direction === 'previous' ? 'chevron-left' : 'chevron-right');
    this.contextValue = 'navigation';
  }
}

/**
 * PostItem: 게시글 항목
 */
class PostItem extends vscode.TreeItem {
  constructor(label, link) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.link = link;
    this.command = {
      command: 'dcinsideCrawler.openPost',
      title: '게시글 열기',
      arguments: [this]
    };
    this.iconPath = new vscode.ThemeIcon("file");
  }
}

/**
 * PostsProvider: 사이드바 트리뷰에 게시글 목록 및 네비게이션(페이지 이동) 아이템을 제공
 */
class PostsProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.posts = [];
    this.currentPage = 1;
    this.hasMore = false;
    this.currentGalleryId = null;
    this.currentMode = 'normal'; // 'normal' 또는 'recommend'
  }

  refresh(posts) {
    this.posts = posts;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element) {
    return element;
  }

  getChildren(element) {
    // 최상위 노드: 상단에 갤러리 선택 옵션 및 게시글 목록, 페이지 이동 버튼 추가
    if (!element) {
      /** @type {vscode.TreeItem[]} */
      let items = [];
      // 갤러리 검색 옵션 버튼 (이 버튼을 누르면 unified 검색 명령어가 실행됩니다.)
      items.push(new SearchItem());
      // 게시글 목록
      items = items.concat(this.posts);
      // 이전 페이지 버튼 (현재 페이지 > 1)
      if (this.currentPage > 1) {
        items.push(new NavigationItem("이전 페이지", 'previous'));
      }
      // 다음 페이지 버튼 (추가 페이지 존재 시)
      if (this.hasMore) {
        items.push(new NavigationItem("다음 페이지", 'next'));
      }
      return items;
    }
    return [];
  }
}

let postsProvider; // 전역 PostsProvider 인스턴스

/**
 * loadGalleryPosts: 갤러리 게시글 목록을 불러오는 함수
 * @param {string} galleryId - 갤러리 ID
 * @param {number} page - 페이지 번호
 * @param {string} mode - 'normal' 또는 'recommend'
 */
async function loadGalleryPosts(galleryId, page, mode = 'normal') {
  // mode에 따라 기본 URL 생성 (기본적으로 mgallery를 사용)
  let url = `https://gall.dcinside.com/mgallery/board/lists/?id=${galleryId}&page=${page}`;
  if (mode === 'recommend') {
    url += '&exception_mode=recommend';
  }
  // fallback URL: mgallery를 제거한 URL (일반 갤러리용)
  let fallbackUrl = `https://gall.dcinside.com/board/lists/?id=${galleryId}&page=${page}`;
  if (mode === 'recommend') {
    fallbackUrl += '&exception_mode=recommend';
  }

  // 최초 요청 (mgallery URL)
  let response = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
  });
  let html = response.data;
  let $ = cheerio.load(html);

  // 만약 리다이렉트 스크립트가 감지된다면,
  // fallbackUrl (mgallery가 없는 URL)로 다시 요청합니다.
  const scriptText = $('script').text();
  if (scriptText.includes('location.replace')) {
    console.log("리다이렉트 감지됨. fallbackUrl로 재요청:", fallbackUrl);
    response = await axios.get(fallbackUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    html = response.data;
    $ = cheerio.load(html);
  }

  // "다음 페이지" 버튼 존재 여부를 확인하여 hasMore 결정
  const hasMore = $('a.page_next').length > 0;
  let posts = [];
  const postElements = $('table.gall_list tbody.listwrap2 tr.ub-content.us-post');
  postElements.each((i, elem) => {
    const title = $(elem).find('.gall_tit a').first().text().trim();
    const linkPartial = $(elem).find('.gall_tit a').attr('href');
    const replyCount = $(elem).find('.gall_tit .reply_numbox span').text();
  
  
    const totalTitle = `${title}${replyCount}`
    if (title && linkPartial && !linkPartial.startsWith('javascript')) {
      const link = linkPartial.startsWith('http')
      ? linkPartial
      : `https://gall.dcinside.com${linkPartial}`;
      posts.push(new PostItem(totalTitle, link));
    }
  });
  return { posts, hasMore };
}


/**
 * unified 검색 명령어: 갤러리 ID를 옵션으로 제공하여 검색할 갤러리를 선택
 */
let searchUnifiedCommand = vscode.commands.registerCommand('dcinsideCrawler.searchUnified', async () => {
  // 미리 정의된 갤러리 ID 옵션 목록
  const galleryOptions = [
	{ label: 'dcbest', description: '실시간베스트 갤러리' },
    { label: 'pebble', description: '돌 갤러리' },
    { label: 'programming', description: '프로그래밍 갤러리' },
    { label: 'github', description: '깃허브 갤러리' },
    { label: 'baseball_new11', description: '국내야구 갤러리' },
    { label: 'employment', description: '취업 갤러리' },
    { label: 'neostock', description: '주식 갤러리' },
    { label: 'stockus', description: '미국주식 갤러리' },
    { label: '직접 입력', description: '직접 갤러리 ID를 입력' }
  ];
  const selectedGallery = await vscode.window.showQuickPick(galleryOptions, {
    placeHolder: '검색할 갤러리 ID를 선택하세요'
  });
  if (!selectedGallery) {
    vscode.window.showWarningMessage('갤러리 ID가 선택되지 않았습니다.');
    return;
  }
  let galleryId = selectedGallery.label;
  if (galleryId === '직접 입력') {
    const inputId = await vscode.window.showInputBox({
      placeHolder: '갤러리 ID를 입력하세요 (예: pebble)',
      prompt: '갤러리 ID'
    });
    if (!inputId) {
      vscode.window.showWarningMessage('갤러리 ID가 입력되지 않았습니다.');
      return;
    }
    galleryId = inputId;
  }
  // 게시글 유형 선택
  const modeOption = await vscode.window.showQuickPick(
    ['일반 게시글', '개념글 (추천)'],
    { placeHolder: '검색할 게시글 유형을 선택하세요' }
  );
  if (!modeOption) {
    vscode.window.showWarningMessage('게시글 유형이 선택되지 않았습니다.');
    return;
  }
  const mode = modeOption === '일반 게시글' ? 'normal' : 'recommend';
  const page = 1;
  try {
    const { posts, hasMore } = await loadGalleryPosts(galleryId, page, mode);
    postsProvider.currentPage = page;
    postsProvider.hasMore = hasMore;
    postsProvider.currentGalleryId = galleryId;
    postsProvider.currentMode = mode;
    global.currentGalleryId = galleryId;
    global.currentPage = page;
    postsProvider.refresh(posts);
  } catch (error) {
    vscode.window.showErrorMessage(`크롤링 중 오류 발생: ${error.message}`);
  }
});

/**
 * "게시글 열기" 명령어: 게시글 상세 내용과 댓글을 Markdown 미리보기로 보여줍니다.
 */
let openPostCommand = vscode.commands.registerCommand('dcinsideCrawler.openPost', async (postItem) => {
  try {
    const postUrl = postItem.link;
    const urlObj = new URL(postUrl, 'https://gall.dcinside.com');
    const galleryId = urlObj.searchParams.get('id');
    const postNo = urlObj.searchParams.get('no');

    const postResponse = await axios.get(postUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    const postHtml = postResponse.data;
    const $$ = cheerio.load(postHtml);

    let postContentHtml = $$('.writing_view_box .write_div').html() || '<p>본문을 찾을 수 없습니다.</p>';
    const content$ = cheerio.load(postContentHtml);
    content$('[style]').removeAttr('style');
    content$('span#dcappfooter').remove();
    postContentHtml = content$.html();

    const turndownService = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced'
    });
    let postContentMarkdown = turndownService.turndown(postContentHtml);
    postContentMarkdown = postContentMarkdown.replace(/!\[(.*?)\]\((https?:\/\/[^)]+)\)/g, (match, alt, url) => {
      const proxyUrl = `http://localhost:3000/?url=${encodeURIComponent(url)}`;
      return `![${alt}](${proxyUrl})`;
    });

    const commentPayload = {
      id: galleryId,
      no: postNo,
      cmt_id: galleryId,
      cmt_no: postNo,
      focus_cno: '',
      focus_pno: '',
      e_s_n_o: '3eabc219ebdd65f1',
      comment_page: '1',
      sort: '',
      prevCnt: '',
      board_type: '',
      _GALLTYPE_: 'M'
    };

    const commentResponse = await axios.post("https://gall.dcinside.com/board/comment/", qs.stringify(commentPayload), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': `https://gall.dcinside.com/mgallery/board/view/?id=${galleryId}&no=${postNo}`,
        'X-Requested-With': 'XMLHttpRequest'
      }
    });
    const commentData = commentResponse.data;
    let commentsMarkdown = '';
    if (commentData && commentData.comments && commentData.comments.length > 0) {
      commentsMarkdown = commentData.comments.map(c => {
        return `- **${c.name}** (${c.reg_date}): ${turndownService.turndown(c.memo)}`;
      }).join('\n');
    } else {
      commentsMarkdown = '댓글이 없습니다.';
    }
    
    const output = `# ${postItem.label}\n\n## 본문\n\n${postContentMarkdown}\n\n## 댓글\n\n${commentsMarkdown}`;
    
    dcContentProvider.updateContent(output);
    vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.parse('dcinside:post'));
    
  } catch (error) {
    vscode.window.showErrorMessage(`게시글 로딩 중 오류 발생: ${error.message}`);
  }
});

/**
 * "페이지 이동" 명령어: 이전/다음 페이지 이동 처리
 */
let navigatePageCommand = vscode.commands.registerCommand('dcinsideCrawler.navigatePage', async (direction) => {
  if (!postsProvider.currentGalleryId) {
    vscode.window.showWarningMessage('갤러리 검색 후 페이지 이동이 가능합니다.');
    return;
  }
  let newPage = postsProvider.currentPage;
  if (direction === 'next') {
    newPage++;
  } else if (direction === 'previous') {
    newPage = Math.max(newPage - 1, 1);
  }
  try {
    const { posts, hasMore } = await loadGalleryPosts(postsProvider.currentGalleryId, newPage, postsProvider.currentMode);
    postsProvider.currentPage = newPage;
    postsProvider.hasMore = hasMore;
    global.currentPage = newPage;
    postsProvider.refresh(posts);
  } catch (error) {
    vscode.window.showErrorMessage(`페이지 이동 중 오류 발생: ${error.message}`);
  }
});

module.exports = {
  activate: function (context) {
    // 프록시 서버 시작
    const proxyServer = startProxyServer(3000);
    context.subscriptions.push({ dispose: () => proxyServer.close() });

    postsProvider = new PostsProvider();
    vscode.window.registerTreeDataProvider('dcinsideExplorer', postsProvider);

    context.subscriptions.push(searchUnifiedCommand);
    context.subscriptions.push(openPostCommand);
    context.subscriptions.push(navigatePageCommand);
  },
  deactivate: function () {}
};

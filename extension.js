const vscode = require('vscode');
const axios = require('axios');
const cheerio = require('cheerio');
const TurndownService = require('turndown');
const qs = require('qs');
const express = require('express');

/**
 * async 핸들러 헬퍼: async 함수를 Express 요청 핸들러로 감싸서 에러를 next로 전달합니다.
 */
function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Express 프록시 서버를 시작하는 함수
 * - 클라이언트가 ?url= 파라미터로 전달한 URL을 요청하고, 
 *   'User-Agent' 및 'Referer' 헤더를 추가하여 이미지를 가져와 반환합니다.
 *
 * @param {number} port - 실행할 포트 (기본: 3000)
 * @returns {server} - Express 서버 객체
 */
function startProxyServer(port = 34523) {
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
 * Markdown 미리보기 전용 ContentProvider
 * "dcinside:post" URI로 제공되는 가상 문서의 내용을 관리합니다.
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
 * TreeItem: 검색 아이콘 버튼 (항상 맨 위에 노출)
 */
class SearchItem extends vscode.TreeItem {
  constructor() {
    super("갤러리 검색", vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon("search");
    this.command = {
      command: 'dcinsideCrawler.searchGallery',
      title: '갤러리 검색'
    };
    this.contextValue = 'searchButton';
  }
}

/**
 * TreeItem: 게시글 항목
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
 * TreeDataProvider: 사이드바 트리뷰에 게시글 목록을 제공
 */
class PostsProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.posts = [];
  }
  refresh(posts) {
    this.posts = posts;
    this._onDidChangeTreeData.fire();
  }
  getTreeItem(element) {
    return element;
  }
  getChildren(element) {
    if (!element) {
      return [new SearchItem()].concat(this.posts);
    }
    return [];
  }
}

/**
 * activate 함수: 확장팩 초기화
 */
function activate(context) {
  // Express 프록시 서버 시작 (포트 3000)
  const proxyServer = startProxyServer(3000);
  context.subscriptions.push({ dispose: () => proxyServer.close() });

  // 트리뷰 등록
  const postsProvider = new PostsProvider();
  vscode.window.registerTreeDataProvider('dcinsideExplorer', postsProvider);

  // "갤러리 검색" 명령어: 갤러리 ID 입력 후 게시글 목록 크롤링
  let searchCommand = vscode.commands.registerCommand('dcinsideCrawler.searchGallery', async () => {
    const galleryId = await vscode.window.showInputBox({
      placeHolder: '크롤링할 디시인사이드 갤러리의 ID를 입력하세요 (예: pebble)',
      prompt: '갤러리 ID'
    });
    if (!galleryId) {
      vscode.window.showWarningMessage('갤러리 ID가 입력되지 않았습니다.');
      return;
    }
    const galleryUrl = `https://gall.dcinside.com/mgallery/board/lists/?id=${galleryId}`;
    try {
      const response = await axios.get(galleryUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
      const html = response.data;
      const $ = cheerio.load(html);

      if ($('script').text().includes('location.replace')) {
        vscode.window.showErrorMessage('리다이렉트가 발생했습니다. 헤더나 URL을 확인하세요.');
        postsProvider.refresh([]);
        return;
      }
      // 게시글 목록 추출: 제목은 <b> 태그 내부의 텍스트만 사용
      const postElements = $('table.gall_list tbody.listwrap2 tr.ub-content.us-post');
      if (postElements.length === 0) {
        vscode.window.showInformationMessage('게시글 목록을 찾을 수 없습니다.');
        postsProvider.refresh([]);
        return;
      }
      let posts = [];
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
      postsProvider.refresh(posts);
    } catch (error) {
      vscode.window.showErrorMessage(`크롤링 중 오류 발생: ${error.message}`);
    }
  });
  context.subscriptions.push(searchCommand);

  // "게시글 열기" 명령어: 게시글 상세 내용 및 댓글을 Markdown으로 변환하고, 프리뷰만 열도록 함
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

      // 게시글 본문 HTML 추출
      let postContentHtml = $$('.writing_view_box .write_div').html() || '<p>본문을 찾을 수 없습니다.</p>';
      const content$ = cheerio.load(postContentHtml);
      content$('[style]').removeAttr('style');
      content$('span#dcappfooter').remove();
      postContentHtml = content$.html();

      // HTML → Markdown 변환 (Turndown)
      const turndownService = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced'
      });
      let postContentMarkdown = turndownService.turndown(postContentHtml);

      // 이미지 URL 치환: 원본 이미지 URL을 프록시 서버 URL로 변경
      postContentMarkdown = postContentMarkdown.replace(/!\[(.*?)\]\((https?:\/\/[^)]+)\)/g, (match, alt, url) => {
        const proxyUrl = `http://localhost:3000/?url=${encodeURIComponent(url)}`;
        return `![${alt}](${proxyUrl})`;
      });

      // 댓글 API 호출
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
      
      // ContentProvider를 업데이트하고, Markdown 프리뷰 창을 엽니다.
      dcContentProvider.updateContent(output);
      vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.parse('dcinside:post'));
      
    } catch (error) {
      vscode.window.showErrorMessage(`게시글 로딩 중 오류 발생: ${error.message}`);
    }
  });
  context.subscriptions.push(openPostCommand);
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};

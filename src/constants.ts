export const DEFAULT_PAGE_SIZE = 50;
export const RECENT_POST_SCAN_LIMIT = 5000;
export const SESSION_COOKIE_NAME = 'nsr_session';
export const CSRF_COOKIE_NAME = 'nsr_csrf';
export const SESSION_TTL_DAYS = 30;

export const CATEGORY_LABELS: Record<string, string> = {
  daily: '日常',
  tech: '技术',
  info: '情报',
  review: '测评',
  trade: '交易',
  carpool: '拼车',
  promote: '推广',
  promotion: '推广',
  life: '生活',
  dev: 'Dev',
  'photo-share': '贴图',
  expose: '曝光',
  sandbox: '沙盒'
};

export const CATEGORY_ORDER = [
  'all',
  'daily',
  'tech',
  'info',
  'review',
  'trade',
  'carpool',
  'promote',
  'life',
  'dev',
  'photo-share',
  'expose',
  'sandbox'
];

export const ICON_SVG = `<svg width="512" height="512" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="24" y="24" width="464" height="464" rx="112" fill="#050505"/><rect x="40" y="40" width="432" height="432" rx="96" stroke="#F5F5F5" stroke-opacity="0.16" stroke-width="8"/><path d="M132 364V148H174L318 294V148H380V364H342L194 214V364H132Z" fill="#FAFAFA"/><circle cx="370" cy="366" r="18" fill="#FAFAFA"/><path d="M334 366C334 346.118 350.118 330 370 330" stroke="#FAFAFA" stroke-width="18" stroke-linecap="round"/><path d="M302 366C302 328.444 332.444 298 370 298" stroke="#FAFAFA" stroke-width="18" stroke-linecap="round" opacity="0.82"/></svg>`;

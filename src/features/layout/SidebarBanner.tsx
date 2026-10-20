/**
 * Баннер внизу сайдбара.
 *
 * Это витрина, а не реклама: ни счётчиков «01/03», ни кнопки. Место рассчитано на будущую строку
 * логотипов сервисов и брендов — пока в нём живёт технологичная картинка: сетка, орбиты и узлы,
 * тот же язык, что у тёмной панели вокруг.
 *
 * Подпись обязательна: без неё картинка читалась как случайное изображение. Текст говорит прямо,
 * что это за карточка и зачем она — место для логотипов сервисов, которые подключают к проекту.
 */
export function SidebarBanner() {
  return <div className="sidebar-banner">
    <div className="sidebar-banner-art">
      <svg viewBox="0 0 300 108" preserveAspectRatio="xMidYMid slice" role="presentation" aria-hidden="true">
        <defs>
          <linearGradient id="sidebar-banner-line" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#8fd3ad"/>
            <stop offset="0.55" stopColor="#6fb6c9"/>
            <stop offset="1" stopColor="#5f8fc9"/>
          </linearGradient>
          <radialGradient id="sidebar-banner-glow" cx="0.18" cy="0.05" r="0.95">
            <stop offset="0" stopColor="#8fd3ad" stopOpacity="0.32"/>
            <stop offset="0.55" stopColor="#5f9ecb" stopOpacity="0.12"/>
            <stop offset="1" stopColor="#5f9ecb" stopOpacity="0"/>
          </radialGradient>
          <pattern id="sidebar-banner-grid" width="13" height="13" patternUnits="userSpaceOnUse">
            <path d="M13 0H0V13" fill="none" stroke="rgba(255,255,255,0.055)" strokeWidth="1"/>
          </pattern>
        </defs>

        <rect width="300" height="108" fill="url(#sidebar-banner-grid)"/>
        <rect width="300" height="108" fill="url(#sidebar-banner-glow)"/>

        {/* Схема: линии вьются из левого нижнего угла и сходятся в узлах. */}
        <g fill="none" stroke="url(#sidebar-banner-line)" strokeWidth="1.1" strokeLinecap="round" opacity="0.9">
          <path d="M-10 92 L52 92 L74 70 L134 70 L154 48 L232 48"/>
          <path d="M-10 66 L36 66 L58 44 L150 44 L172 22 L246 22"/>
          <path d="M120 118 L120 84 L148 56 L148 12"/>
          <path d="M232 48 L286 48"/>
          <path d="M246 22 L300 22"/>
        </g>

        <g fill="#0d1116" stroke="url(#sidebar-banner-line)" strokeWidth="1.2">
          <circle cx="74" cy="70" r="3.1"/>
          <circle cx="134" cy="70" r="2.4"/>
          <circle cx="58" cy="44" r="3.1"/>
          <circle cx="150" cy="44" r="2.4"/>
          <circle cx="154" cy="48" r="3.4"/>
          <circle cx="172" cy="22" r="2.4"/>
          <circle cx="232" cy="48" r="3.1"/>
          <circle cx="246" cy="22" r="2.6"/>
        </g>

        {/* Орбиты: тонкие кольца вокруг одного узла — «система», а не отдельная карточка. */}
        <g fill="none" stroke="rgba(143,211,173,0.30)">
          <circle cx="236" cy="82" r="19"/>
          <circle cx="236" cy="82" r="30" strokeDasharray="2 6" opacity="0.7"/>
        </g>
        <circle cx="236" cy="82" r="3.4" fill="#8fd3ad"/>
        <circle cx="255" cy="70" r="1.9" fill="#6fb6c9"/>
        <circle cx="219" cy="92" r="1.6" fill="#8fd3ad" opacity="0.8"/>
      </svg>
    </div>
    <div className="sidebar-banner-copy">
      <span className="sidebar-banner-eyebrow">ВИТРИНА СЕРВИСОВ</span>
      <strong>Здесь появятся логотипы сервисов</strong>
      <span>Сервисы, которые подключают к проекту в «Интеграциях».</span>
    </div>
  </div>;
}

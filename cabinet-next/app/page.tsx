"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, AlertCircle, ArrowRight, Bell, BookOpen, Bot, Check,
  Banknote, BrainCircuit, Building2, ChevronDown, CircleHelp, ClipboardCheck, Clock3, Copy, CreditCard, Database, Download, ExternalLink,
  FileUp, Flame, Globe2, GraduationCap, Headphones, History, Inbox, Info, LayoutDashboard, LifeBuoy, Link2, ListFilter,
  MessageSquareText, MoreHorizontal, MousePointerClick, Plus, Rocket, Search, Send, Settings2,
  ShieldCheck, SlidersHorizontal, Sparkles, Target, TestTube2, Users, WandSparkles,
  ArrowLeft, Phone, Wallet, Workflow, X, Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger,
} from "@/components/ui/sheet";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent,
  SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuBadge,
  SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarRail, SidebarTrigger, useSidebar,
} from "@/components/ui/sidebar";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

type View = "dashboard" | "readiness" | "attention" | "dialogs" | "training" | "tests" | "knowledge" | "widget" | "install" | "integrations" | "leads" | "crm" | "billing" | "team" | "support";

// Real data from our existing NestJS API (same origin as this app, so the
// browser's own smartchat_cabinet_session cookie is sent automatically — no
// separate auth wiring needed here). Both endpoints already existed before
// this app did; nothing added on the backend for these two. Typed loosely
// (not the full response shape) — only the fields this page actually reads.
type CabinetMe = {
  companyName: string;
  bot: { id: string; name: string; label: string; sourceWebsite: string | null; widgetToken: string } | null;
  userName: string;
  companyRole: string;
} | null;

type CabinetAnalytics = {
  shown: { count: number; deltaPct: number | null };
  opened: { count: number; conversionRate: number; openedToDialogRate: number; deltaPct: number | null };
  dialogs: { count: number; conversionRate: number; deltaPct: number | null };
  leads: { count: number; conversionRate: number; deltaPct: number | null };
  problems: { count: number; resolved: number };
  escalations: {
    pending: Array<{ id: string; reason: string; question: string; botReply: string | null; createdAt: string; visitorQuestion?: string }>;
    needsVerification: Array<{ id: string; question: string; answer: string; answeredAt: string }>;
    verifiedCount: number;
    reviewedCount: number;
  };
} | null;

const ESCALATION_REASON_LABELS: Record<string, string> = { dissatisfaction: "Недоволен ответом", disliked: "Дизлайк тестировщика" };

// A single failed GET (a network blip, or the app server restarting mid-
// deploy — a plain `pm2 restart` on this single-instance process is a real
// few-hundred-ms gap) used to leave state null forever, no retry — the page
// looked permanently empty until a manual reload. Retries with backoff;
// 401 (genuinely logged out) returns immediately since retrying won't help.
async function fetchJsonWithRetry<T>(url: string, attempts = 5): Promise<T | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return (await r.json()) as T;
      if (r.status === 401) return null;
    } catch {
      // network error — fall through to retry below
    }
    if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 500 * (i + 1)));
  }
  return null;
}

type AnalyticsPeriod = "yesterday" | "week" | "month" | "all";

function useCabinetData() {
  const [me, setMe] = useState<CabinetMe>(null);
  const [analytics, setAnalytics] = useState<CabinetAnalytics>(null);
  const [signedOut, setSignedOut] = useState(false);
  // "Вчера"/"Неделя"/"Месяц"/"Всё время" tabs used to be pure decoration —
  // uncontrolled <Tabs>, so clicking one only changed which tab LOOKED
  // active, nothing ever re-fetched analytics with a different period (found
  // live: switching to "Месяц" left every number exactly as it was for
  // "Неделя"). period is real state now; refetchAnalytics defaults to
  // whatever period is currently selected (so escalation actions elsewhere
  // that just call refetchAnalytics() keep refreshing the SAME period the
  // owner is looking at), changePeriod is the one that actually switches it.
  const [period, setPeriod] = useState<AnalyticsPeriod>("week");
  const refetchAnalytics = (p: AnalyticsPeriod = period) => {
    fetchJsonWithRetry<CabinetAnalytics>(`/api/cabinet/analytics?period=${p}`).then(setAnalytics);
  };
  const changePeriod = (p: AnalyticsPeriod) => {
    setPeriod(p);
    refetchAnalytics(p);
  };
  useEffect(() => {
    // No session cookie (a real logout, an expired session, or — confirmed
    // live — just opening this URL in a private/incognito window expecting
    // to already be signed in there, which is impossible by design) used to
    // look EXACTLY like "data won't load": every number sat at its "…"
    // placeholder forever with zero indication why. /api/cabinet/me is the
    // one authoritative "am I signed in" check — a 401 specifically from
    // THIS call (not analytics, not any other endpoint) means genuinely
    // signed out, so send them to the real sign-in page instead of leaving
    // them staring at a blank dashboard.
    fetch("/api/cabinet/me").then((r) => {
      if (r.status === 401) {
        setSignedOut(true);
        window.location.href = "/cabinet/login.html";
        return;
      }
      return r.ok ? r.json() : fetchJsonWithRetry<CabinetMe>("/api/cabinet/me");
    }).then((data) => { if (data) setMe(data); });
    refetchAnalytics();
  }, []);
  return { me, analytics, refetchAnalytics, signedOut, period, changePeriod };
}

// Real getAnalytics numbers are integers; ru-RU grouping matches the
// reference's own hardcoded "2 480"-style formatting instead of "2,480".
function fmtNum(n: number | undefined): string {
  return n === undefined ? "…" : n.toLocaleString("ru-RU");
}
function fmtPct(n: number | undefined): string {
  return n === undefined ? "…" : `${Math.round(n * 10) / 10}%`.replace(".", ",");
}

const nav = [
  { label: "Работа", items: [
    { id: "dashboard" as View, label: "Обзор", icon: LayoutDashboard },
    { id: "attention" as View, label: "Требует внимания", icon: AlertCircle, badge: "0" },
    { id: "dialogs" as View, label: "Диалоги", icon: MessageSquareText },
    { id: "training" as View, label: "Обучение бота", icon: GraduationCap },
    { id: "tests" as View, label: "Автотесты", icon: TestTube2, badge: "92%" },
    { id: "knowledge" as View, label: "База знаний", icon: BookOpen, badge: "17" },
  ]},
  { label: "Настройка", items: [
    { id: "readiness" as View, label: "Статус внедрения", icon: Rocket, badge: "75%" },
    { id: "widget" as View, label: "Виджет и приветствие", icon: SlidersHorizontal },
    { id: "install" as View, label: "Установка", icon: Link2 },
    { id: "integrations" as View, label: "Интеграции", icon: Workflow },
  ]},
  { label: "Продажи", items: [
    { id: "leads" as View, label: "Лиды", icon: Inbox, badge: "7" },
    { id: "crm" as View, label: "CRM", icon: Target },
  ]},
  { label: "Аккаунт", items: [
    { id: "billing" as View, label: "Тариф и оплата", icon: CreditCard },
    { id: "team" as View, label: "Команда", icon: Users },
    { id: "support" as View, label: "Поддержка", icon: LifeBuoy },
  ]},
];

const titles: Record<View, { title: string; desc: string }> = {
  dashboard: { title: "Обзор", desc: "Главное о работе бота и движении посетителей к заявке" },
  readiness: { title: "Статус внедрения", desc: "Что уже настроил менеджер и что осталось до запуска" },
  attention: { title: "Требует внимания", desc: "Слабые ответы и повторяющиеся вопросы в одном месте" },
  dialogs: { title: "Диалоги", desc: "Все разговоры посетителей с ботом" },
  training: { title: "Обучение бота", desc: "Проверьте диалог глазами посетителя и улучшите ответы" },
  tests: { title: "Автотесты", desc: "Проверка продаж, знаний и сложных ситуаций до встречи с клиентом" },
  knowledge: { title: "База знаний", desc: "Проверенные факты, инструкции и ответы о вашем бизнесе" },
  widget: { title: "Виджет и приветствие", desc: "Внешний вид, голос и первый контакт с посетителем" },
  install: { title: "Установка", desc: "Подключите готового бота к сайту" },
  integrations: { title: "Интеграции", desc: "Заявки и уведомления в сервисах вашей команды" },
  leads: { title: "Лиды", desc: "Контакты, потребность и следующий шаг без чтения всего диалога" },
  crm: { title: "CRM", desc: "Заявки от первого контакта до результата" },
  billing: { title: "Тариф и оплата", desc: "Выберите удобную модель оплаты и управляйте расходами" },
  team: { title: "Команда", desc: "Роли сотрудников и доступ к сделкам" },
  support: { title: "Поддержка", desc: "Вопросы по кабинету, боту и подключению" },
};

function Brand() {
  return <div className="brand"><span className="brand-icon"><i /><i /><i /></span><span className="brand-text"><b>Умный Чат</b><small>Личный кабинет</small></span></div>;
}

function StatusPill({ tone = "green", children }: { tone?: "green" | "blue" | "orange" | "gray"; children: React.ReactNode }) {
  return <span className={`status-pill ${tone}`}>{children}</span>;
}

function PageHeader({ view, onPrimary, companyName }: { view: View; onPrimary?: (label: string) => void; companyName: string }) {
  // crm and knowledge dropped from here — both now have their own real
  // buttons (CRM(): "Новая сделка" -> POST /api/cabinet/deals; Knowledge():
  // "Добавить знания" -> AddKnowledgeSheet, real POST to
  // article/file/bulk/site); this generic header slot only ever opened the
  // fake "demo state" dialog, so with both on screen at once the header's
  // copy was a confusing, non-functional duplicate (found live, testing the
  // real button: the header's fake one sits first in the DOM and shadows it).
  const actions: Partial<Record<View, string>> = { dialogs: "Экспорт", integrations: "Добавить интеграцию", team: "Пригласить", support: "Новое обращение" };
  const action = actions[view];
  return <div className="page-header"><div><div className="crumb">{companyName} <span>/</span> {titles[view].title}</div><h1>{titles[view].title}</h1><p>{titles[view].desc}</p></div>{action && <Button className="primary-action" data-live onClick={() => onPrimary?.(action)}><Plus />{action}</Button>}</div>;
}

function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const notices = [
    { icon: Target, tone: "orange", title: "Новая заявка без ответа", text: "Анна оставила телефон 18 минут назад", time: "12:41" },
    { icon: AlertCircle, tone: "violet", title: "Бот не уверен в ответе", text: "Вопрос о доставке за пределы региона", time: "11:08" },
    { icon: CreditCard, tone: "blue", title: "Пробный период закончится через 3 дня", text: "Выберите модель оплаты, чтобы бот не остановился", time: "вчера" },
  ];
  return <Sheet open={open} onOpenChange={setOpen}><SheetTrigger asChild><button className="icon-button" data-live aria-label="Уведомления"><Bell /><i /></button></SheetTrigger><SheetContent className="notification-sheet"><SheetHeader><SheetTitle>Требует внимания</SheetTitle><SheetDescription>Только события, для которых нужно ваше действие.</SheetDescription></SheetHeader><div className="notification-list">{notices.map(({icon:Icon,tone,title,text:copy,time}) => <button key={title} onClick={() => setOpen(false)}><span className={`event-icon ${tone}`}><Icon /></span><p><b>{title}</b><small>{copy}</small></p><time>{time}</time><ArrowRight /></button>)}</div><div className="notification-rule"><Info/><p><b>Обычные диалоги сюда не попадают</b><small>Колокольчик показывает только лиды, ошибки, лимиты и проблемы интеграций.</small></p></div></SheetContent></Sheet>;
}

function Topbar({ onAction, botLabel, userName, userInitial, roleLabel }: { onAction: (label: string) => void; botLabel: string; userName: string; userInitial: string; roleLabel: string }) {
  return <header className="topbar"><div className="topbar-left"><SidebarTrigger /><button className="bot-select" data-live onClick={() => onAction("Выбор бота")}><span className="bot-dot"><Bot /></span><span><small>Ваш бот</small><b>{botLabel}</b></span><ChevronDown /></button></div><div className="topbar-right"><NotificationCenter/><button className="profile" data-live onClick={() => onAction("Профиль и настройки аккаунта")}><span>{userInitial}</span><div><b>{userName}</b><small>{roleLabel}</small></div><ChevronDown /></button></div></header>;
}

function TrialBar({ onBilling }: { onBilling: () => void }) {
  return <div className="trial-bar"><div><Sparkles /><span><b>Пробный период активен</b><small>Осталось 15 дней</small></span></div><div className="trial-progress"><i style={{ width: "42%" }} /></div><button data-live onClick={onBilling}>Выбрать тариф <ArrowRight /></button></div>;
}

function Metric({ label, value, note, tone, icon: Icon }: { label: string; value: string; note: string; tone: string; icon: React.ElementType }) {
  return <article className="metric-card"><div className={`metric-icon ${tone}`}><Icon /></div><div className="metric-top"><span>{label}</span><MoreHorizontal /></div><strong>{value}</strong><small>{note}</small></article>;
}

function ConversionChart() {
  return <article className="panel chart-panel"><div className="panel-head"><div><span className="section-label">Динамика</span><h2>Конверсия по дням</h2></div><StatusPill tone="blue">+1,8 п.п.</StatusPill></div><div className="chart-legend"><span><i className="line-main"/>В заявку</span><span><i className="line-open"/>В открытие чата</span></div><div className="line-chart" role="img" aria-label="График конверсии в открытие чата и заявку за семь дней"><svg viewBox="0 0 620 220" preserveAspectRatio="none"><g className="grid-lines"><line x1="28" y1="35" x2="610" y2="35"/><line x1="28" y1="92" x2="610" y2="92"/><line x1="28" y1="149" x2="610" y2="149"/><line x1="28" y1="205" x2="610" y2="205"/></g><defs><linearGradient id="chartFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#6579e8" stopOpacity=".22"/><stop offset="1" stopColor="#6579e8" stopOpacity="0"/></linearGradient></defs><path className="chart-area" d="M28,158 L124,144 L221,151 L318,122 L415,111 L512,92 L610,79 L610,205 L28,205 Z"/><polyline className="chart-open-line" points="28,86 124,78 221,94 318,65 415,70 512,50 610,42"/><polyline className="chart-main-line" points="28,158 124,144 221,151 318,122 415,111 512,92 610,79"/><g className="chart-dots"><circle cx="28" cy="158" r="4"/><circle cx="124" cy="144" r="4"/><circle cx="221" cy="151" r="4"/><circle cx="318" cy="122" r="4"/><circle cx="415" cy="111" r="4"/><circle cx="512" cy="92" r="4"/><circle cx="610" cy="79" r="5"/></g></svg><div className="chart-axis"><span>21 авг</span><span>22</span><span>23</span><span>24</span><span>25</span><span>26</span><span>27 авг</span></div></div><div className="chart-summary"><div><small>В заявку</small><b>4,8%</b><span>+1,1 п.п.</span></div><div><small>В открытие</small><b>29,9%</b><span>+1,8 п.п.</span></div></div></article>;
}

// Dashboard's own tab labels ("Вчера") don't match the backend's period
// values ("yesterday") one-for-one — this is the one place that mapping
// happens, so Tabs' value stays the human label the reference already used.
const PERIOD_TAB_TO_BACKEND: Record<string, AnalyticsPeriod> = { day: "yesterday", week: "week", month: "month", all: "all" };
const PERIOD_RANGE_LABEL: Record<AnalyticsPeriod, string> = { yesterday: "За вчера", week: "Последние 7 дней", month: "Последние 30 дней", all: "За всё время" };

function Dashboard({ setView, onAction, analytics, period, onPeriodChange }: { setView: (v: View) => void; onAction: (label: string) => void; analytics: CabinetAnalytics; period: AnalyticsPeriod; onPeriodChange: (p: AnalyticsPeriod) => void }) {
  const periodTab = Object.entries(PERIOD_TAB_TO_BACKEND).find(([, backend]) => backend === period)?.[0] ?? "week";
  const shown = analytics?.shown.count;
  const opened = analytics?.opened.count;
  const dialogs = analytics?.dialogs.count;
  const leads = analytics?.leads.count;
  // Bar widths in the funnel below are relative to the first (largest)
  // stage — same visual idea as the reference's own hardcoded 100/82/65/46,
  // just computed from real counts instead.
  const pct = (n: number | undefined) => (shown && n !== undefined && shown > 0 ? Math.max(4, Math.round((n / shown) * 100)) : 0);
  return <>
    <div className="dashboard-toolbar"><Tabs value={periodTab} onValueChange={(v) => onPeriodChange(PERIOD_TAB_TO_BACKEND[v] ?? "week")}><TabsList><TabsTrigger value="day">Вчера</TabsTrigger><TabsTrigger value="week">Неделя</TabsTrigger><TabsTrigger value="month">Месяц</TabsTrigger><TabsTrigger value="all">Всё время</TabsTrigger></TabsList></Tabs><button className="date-filter"><ListFilter /> {PERIOD_RANGE_LABEL[period]}</button></div>
    <section className="metrics-grid"><Metric label="Посетители" value={fmtNum(shown)} note="На страницах с виджетом" tone="violet" icon={Activity} /><Metric label="Открыли чат" value={fmtNum(opened)} note={`${fmtPct(analytics?.opened.conversionRate)} посетителей`} tone="cyan" icon={MousePointerClick} /><Metric label="Диалоги" value={fmtNum(dialogs)} note={`${fmtPct(analytics?.dialogs.conversionRate)} посетителей начали разговор`} tone="green" icon={MessageSquareText} /><Metric label="Заявки" value={fmtNum(leads)} note={`${fmtPct(analytics?.leads.conversionRate)} диалогов оставили контакт`} tone="lime" icon={Target} /></section>
    <section className="dashboard-grid">
      <article className="panel funnel-panel"><div className="panel-head"><div><span className="section-label">Воронка</span><h2>Путь посетителя к заявке</h2></div><button className="ghost-action" data-live onClick={() => onAction("Как считается воронка")}>Как считается <ArrowRight /></button></div><div className="funnel"><div className="funnel-stage"><span>Посетитель</span><b>{fmtNum(shown)}</b><i style={{ width: `${pct(shown)}%` }} /></div><div className="funnel-arrow"><span>{fmtPct(analytics?.opened.conversionRate)}</span><ArrowRight /></div><div className="funnel-stage"><span>Открыл чат</span><b>{fmtNum(opened)}</b><i style={{ width: `${pct(opened)}%` }} /></div><div className="funnel-arrow"><span>{fmtPct(analytics?.opened.openedToDialogRate)}</span><ArrowRight /></div><div className="funnel-stage"><span>Диалог</span><b>{fmtNum(dialogs)}</b><i style={{ width: `${pct(dialogs)}%` }} /></div><div className="funnel-arrow"><span>{fmtPct(analytics?.leads.conversionRate)}</span><ArrowRight /></div><div className="funnel-stage"><span>Заявка</span><b>{fmtNum(leads)}</b><i style={{ width: `${pct(leads)}%` }} /></div></div><div className="insight"><Info /><div><b>Показатели собираются автоматически</b><span>Виджет фиксирует посещения, открытия чата, начатые диалоги и полученные контакты.</span></div><button data-live onClick={() => onAction("События аналитики")}>Подробнее</button></div></article>
      <ConversionChart/>
      <article className="panel readiness-card"><div className="readiness-ring"><svg viewBox="0 0 88 88"><circle cx="44" cy="44" r="37" /><circle className="ready manager-progress" cx="44" cy="44" r="37" /></svg><strong>75%</strong></div><div><span className="section-label">Внедрение с менеджером</span><h2>Подготовка к запуску</h2><p>Менеджер настраивает сценарий, знания и подключения. Здесь виден общий статус.</p><button className="inline-action" data-live onClick={() => setView("readiness")}>Открыть план <ArrowRight /></button></div></article>
      {(() => {
        // This card was still showing the reference's static demo numbers
        // (0/34/8) — real data existed on the Attention page itself
        // (analytics.escalations.pending/needsVerification) but was never
        // wired here, so this summary silently disagreed with the real
        // queue right next to it.
        const esc = analytics?.escalations;
        const needsAttention = esc ? esc.pending.length + esc.needsVerification.length : undefined;
        const reviewed = esc?.reviewedCount;
        const improved = esc?.verifiedCount;
        // Loading (esc undefined) is its own tone/label, not folded into the
        // "0 issues" case — both left needsAttention falsy, so before analytics
        // resolves this briefly claimed a reassuring "Всё хорошо" with no data
        // loaded yet, unlike the numbers themselves which correctly show "…".
        const pillTone = !esc ? "gray" : needsAttention ? "orange" : "green";
        const pillLabel = !esc ? "Загружаю…" : needsAttention ? "Есть что проверить" : "Всё хорошо";
        return <article className="panel quality-panel"><div className="panel-head"><div><span className="section-label">Качество</span><h2>Ответы под контролем</h2></div><StatusPill tone={pillTone}>{pillLabel}</StatusPill></div><div className="quality-stats"><div><b>{fmtNum(needsAttention)}</b><span>требуют внимания</span></div><div><b>{fmtNum(reviewed)}</b><span>проверено</span></div><div><b>{fmtNum(improved)}</b><span>улучшено</span></div></div><button className="wide-ghost" data-live onClick={() => setView("attention")}>Открыть центр качества</button></article>;
      })()}
      <article className="panel activity-panel"><div className="panel-head"><div><span className="section-label">История изменений</span><h2>Что происходило с ботом</h2></div><button className="ghost-action" data-live onClick={() => onAction("Вся история активности")}>Показать все <ArrowRight/></button></div><div className="timeline"><div><span className="event-icon green"><Check /></span><p><b>Менеджер обновил базу знаний</b><small>Добавлено 16 записей с сайта</small></p><time>12:40</time></div><div><span className="event-icon blue"><TestTube2 /></span><p><b>Завершена проверка ответов</b><small>44 из 48 сценариев пройдены</small></p><time>11:18</time></div><div><span className="event-icon violet"><Rocket /></span><p><b>Обновлён этап внедрения</b><small>Следующий шаг — тестирование на сайте</small></p><time>вчера</time></div></div></article>
    </section>
  </>;
}

const checklist = [
  ["Заявка и демо-доступ", "Доступ на 15 дней открыт", 15, true],
  ["Знакомство с менеджером", "Задачи бизнеса и сайт зафиксированы", 15, true],
  ["Настройка сценария", "Менеджер настроил вопросы и передачу заявки", 20, true],
  ["База знаний", "17 записей добавлены и проверены", 25, true],
  ["Проверка ответов", "Менеджер проводит тестовые диалоги", 15, false],
  ["Установка и интеграции", "Виджет, CRM и уведомления", 10, false],
];

function Readiness({ setView }: { setView: (v: View) => void }) {
  return <div className="readiness-layout"><article className="readiness-hero panel"><div><span className="section-label">Внедрение включено в любой тариф</span><h2>Менеджер готовит бот к запуску вместе с вами</h2><p>После заявки и получения демо-доступа менеджер связывается с клиентом, настраивает сценарий, помогает собрать знания, проверяет ответы и подключает продукт.</p><Button className="primary-action" data-live onClick={() => setView("support")}>Написать менеджеру <ArrowRight /></Button></div><div className="big-progress"><strong>75%</strong><Progress value={75} /><small>Следующий этап: проверка ответов</small></div></article><div className="checklist">{checklist.map(([name, desc, weight, done]) => <article className={`check-row ${done ? "done" : "next"}`} key={String(name)}><span className="check-state">{done ? <Check /> : <Clock3 />}</span><div><b>{name}</b><small>{desc}</small></div><StatusPill tone={done ? "green" : "orange"}>{done ? `Готово · ${weight}%` : `В работе · ${weight}%`}</StatusPill></article>)}</div><aside className="manager-card panel"><span className="manager-avatar">М</span><span className="section-label">Ваш менеджер внедрения</span><h2>Мария помогает с запуском</h2><p>Вопросы по настройке, базе знаний, тестам и установке можно передать одному человеку — без самостоятельного внедрения.</p><div className="manager-meta"><span><b>Следующий шаг</b><small>Проверить ответы и согласовать запуск</small></span><span><b>Связь</b><small>В рабочее время через кабинет</small></span></div><Button className="primary-action" data-live onClick={() => setView("support")}>Связаться с менеджером</Button><Button variant="outline" data-live onClick={() => setView("integrations")}>Посмотреть подключения</Button></aside></div>;
}

// Real /api/cabinet/analytics escalations.pending/needsVerification — same
// two queues the old cabinet showed, same real actions (mark processed /
// mark verified), just laid out with this reference's own panel/article
// vocabulary since its Attention view never had a real queue design of its
// own (only this empty state). Omitted for now: the old cabinet's "Открыть
// диалог" full-thread modal — the escalation's own question/reply already
// show inline below without the extra fetch+modal.
function Attention({ analytics, onProcessed }: { analytics: CabinetAnalytics; onProcessed: () => void }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  if (!analytics) return <div className="attention-layout"><article className="panel empty-quality"><p>Загружаю…</p></article></div>;

  const pending = analytics.escalations.pending;
  const needsVerification = analytics.escalations.needsVerification;

  const markProcessed = async (id: string) => {
    setBusyId(id);
    try {
      await fetch(`/api/cabinet/escalations/${id}/process`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ processed: true }),
      });
      onProcessed();
    } finally {
      setBusyId(null);
    }
  };
  const markVerified = async (id: string) => {
    setBusyId(id);
    try {
      await fetch(`/api/cabinet/escalations/${id}/verify`, { method: "POST" });
      onProcessed();
    } finally {
      setBusyId(null);
    }
  };

  if (pending.length === 0 && needsVerification.length === 0) {
    return <div className="attention-layout"><article className="panel empty-quality"><div className="empty-orbit"><ShieldCheck /></div><h2>Сейчас всё под контролем</h2><p>Нет ответов, которые требуют проверки. Когда бот столкнётся со сложным вопросом или получит негативную оценку, он появится здесь.</p></article><aside className="panel how-panel"><span className="section-label">Как это работает</span><h3>Единый центр качества</h3><ul><li><span>1</span>Бот отмечает слабый ответ</li><li><span>2</span>Вы добавляете правильную информацию</li><li><span>3</span>Ответ сразу попадает в базу знаний</li></ul></aside></div>;
  }

  return <div className="attention-layout">
    <section>
      {pending.length > 0 && <article className="panel">
        <span className="section-label">Ждут ответа</span>
        <h2>Бот не смог ответить</h2>
        {pending.map((e) => <PendingEscalationRow key={e.id} e={e} busy={busyId === e.id} onProcess={() => markProcessed(e.id)} onAnswered={onProcessed} />)}
      </article>}
      {needsVerification.length > 0 && <article className="panel">
        <span className="section-label">Ответили — нужна проверка</span>
        <h2>Проверьте ответ в тестовом чате</h2>
        {needsVerification.map((e) => <div key={e.id} className="escalation-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span className="check-state"><Clock3 /></span>
            <div className="escalation-text"><b>{e.question}</b><small>{e.answer}</small></div>
          </div>
          <Button variant="outline" disabled={busyId === e.id} onClick={() => markVerified(e.id)}>Отметить проверенным</Button>
        </div>)}
      </article>}
    </section>
    <aside className="panel how-panel"><span className="section-label">Как это работает</span><h3>Единый центр качества</h3><ul><li><span>1</span>Бот отмечает слабый ответ</li><li><span>2</span>Вы добавляете правильную информацию</li><li><span>3</span>Ответ сразу попадает в базу знаний</li></ul></aside>
  </div>;
}

// Draft-then-confirm answer flow for one pending escalation: preview never
// writes anything (POST .../answer/preview, with the owner's own draft text
// or empty to have the bot suggest one from the business's own systemPrompt),
// confirm (POST .../answer/confirm) is the only step that saves the answer
// and delivers it into the live dialog — mirrors the same two-step shape
// Telegram's own reply flow already uses (TelegramService.handleReplyAnswer).
function PendingEscalationRow({
  e,
  busy,
  onProcess,
  onAnswered,
}: {
  e: { id: string; reason: string; question: string; botReply: string | null; visitorQuestion?: string };
  busy: boolean;
  onProcess: () => void;
  onAnswered: () => void;
}) {
  const [answering, setAnswering] = useState(false);
  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  // Bumped on every requestPreview call and read back when its fetch settles,
  // so a cancelled/superseded request can never overwrite state a later one
  // (or "Отмена") already moved on from — without this, clicking "Отмена"
  // then reopening with a fresh draft while the first request is still in
  // flight let its late response clobber the reopened form with stale text.
  const previewRequestId = useRef(0);

  // sourceText omitted -> use the owner's own draft (or "" for a from-scratch
  // suggestion if the draft is empty too). Passed explicitly when refining an
  // already-generated preview: the backend's previewEscalationAnswer polishes
  // whatever text it's given rather than suggesting fresh, so sending the
  // CURRENT (possibly hand-edited) preview back in is what makes "improve
  // this, I already fixed part of it" actually work instead of silently
  // re-running the original draft/suggestion and discarding the edit.
  const requestPreview = async (sourceText?: string) => {
    const requestId = ++previewRequestId.current;
    setPreviewLoading(true);
    setPreview(null);
    try {
      const text = (sourceText ?? draft).trim();
      const r = await fetch(`/api/cabinet/escalations/${e.id}/answer/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(text ? { text } : {}),
      });
      const data = r.ok ? await r.json() : null;
      if (previewRequestId.current !== requestId) return; // superseded — ignore
      setPreview(data?.text || "Не получилось подготовить ответ, попробуйте ещё раз.");
    } catch {
      if (previewRequestId.current !== requestId) return;
      setPreview("Не получилось подготовить ответ, попробуйте ещё раз.");
    } finally {
      if (previewRequestId.current === requestId) setPreviewLoading(false);
    }
  };

  const confirmAnswer = async () => {
    if (!preview) return;
    setConfirming(true);
    try {
      const r = await fetch(`/api/cabinet/escalations/${e.id}/answer/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: preview }),
      });
      if (r.ok) {
        setConfirmed(true);
        onAnswered();
      }
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div className="escalation-row" style={{ flexDirection: "column", alignItems: "stretch" }}>
      <div className="escalation-row-head" style={{ display: "flex", alignItems: "center", gap: 12, width: "100%" }}>
        <span className="check-state"><AlertCircle /></span>
        <div className="escalation-text" style={{ minWidth: 0 }}>
          <b>{ESCALATION_REASON_LABELS[e.reason] || "Нет ответа"}</b>
          <small>{e.visitorQuestion || e.question}{e.botReply ? ` — ответ бота: ${e.botReply}` : ""}</small>
        </div>
      </div>
      {!answering && !confirmed && (
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <Button variant="outline" style={{ flex: 1 }} onClick={() => setAnswering(true)}>Ответить</Button>
          <Button variant="outline" style={{ flex: 1 }} disabled={busy} onClick={onProcess}>Обработано</Button>
        </div>
      )}

      {confirmed && (
        <p style={{ color: "#237a52", fontSize: 12, margin: 0, paddingLeft: 34 }}>
          Ответ отправлен в диалог и ждёт вашей проверки в разделе ниже.
        </p>
      )}

      {answering && !confirmed && (
        <div style={{ marginTop: 8, paddingLeft: 34, display: "flex", flexDirection: "column", gap: 8 }}>
          <textarea
            value={draft}
            onChange={(ev) => setDraft(ev.target.value)}
            placeholder="Свой вариант ответа (необязательно — оставьте пустым, чтобы бот предложил вариант сам)"
            rows={2}
            style={{ width: "100%", resize: "vertical", font: "inherit", padding: "8px 10px", borderRadius: 10, border: "1px solid var(--line)" }}
          />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button variant="outline" disabled={previewLoading} onClick={() => requestPreview()}>
              {previewLoading ? "Готовлю…" : draft.trim() ? "Проверить мой ответ" : "Сгенерировать ответ"}
            </Button>
            <Button variant="outline" onClick={() => { previewRequestId.current++; setAnswering(false); setPreview(null); setDraft(""); }}>
              Отмена
            </Button>
          </div>
          {(previewLoading || preview !== null) && (
            // previewLoading is checked here too, not just preview !== null:
            // requestPreview() clears preview to null the instant a refine/
            // regenerate click fires, so gating on preview alone made this
            // whole box (confirm button included) vanish mid-refine every
            // time — and since the textarea below is controlled by preview,
            // an owner who selected-all-and-deleted the text to retype it
            // drove preview to "" (equally falsy), vanishing the box mid-edit
            // for the exact same reason. Loading is now its own disabled
            // state instead of an unmount.
            <div style={{ padding: 12, background: "var(--secondary)", borderRadius: 12, display: "flex", flexDirection: "column", gap: 8 }}>
              <textarea
                value={previewLoading ? "" : preview ?? ""}
                onChange={(ev) => setPreview(ev.target.value)}
                placeholder={previewLoading ? "Готовлю…" : undefined}
                disabled={previewLoading}
                rows={3}
                style={{ width: "100%", resize: "vertical", font: "inherit", padding: "8px 10px", borderRadius: 10, border: "1px solid var(--line)", background: "#fff" }}
              />
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Button disabled={confirming || previewLoading || !preview?.trim()} onClick={confirmAnswer}>{confirming ? "Отправляю…" : "Подтвердить и отправить"}</Button>
                <Button variant="outline" disabled={previewLoading || !preview?.trim()} onClick={() => requestPreview(preview ?? undefined)}>
                  Улучшить с учётом правок
                </Button>
                <Button variant="ghost" disabled={previewLoading} onClick={() => requestPreview("")}>
                  Предложить с нуля
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type DialogListItem = {
  id: string;
  botName: string;
  status: string;
  updatedAt: string;
  messageCount: number;
  lastMessagePreview: string | null;
  hasUnansweredEscalation: boolean;
  lead: { name: string | null; phone: string | null; email: string | null } | null;
  dealId: string | null;
  dealTitle: string | null;
};
type DialogDetail = {
  id: string;
  botName: string;
  lead: { name: string | null; phone: string | null; email: string | null } | null;
  dealTitle: string | null;
  messages: Array<{ id: string; role: string; content: string; createdAt: string }>;
};

// Always Europe/Moscow, regardless of the viewer's own browser timezone —
// business requirement ("по МСК"): a message time should read the same for
// everyone looking at this dialog, not shift per viewer.
function fmtMessageTime(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function fmtDialogDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("ru-RU", { day: "2-digit", month: "short" });
}

// Real /api/cabinet/dialogs + /api/cabinet/dialogs/:id — same two endpoints
// and the same list/detail conventions the old cabinet used (title = lead
// name or bot name, "Ждёт ответа"/"Заявка получена" pill logic, deal-context
// box). AI-резюме is real (POST /api/cabinet/dialogs/:id/summary, on demand,
// below). One thing from the reference's own demo markup is still NOT here:
// "Взять диалог" has no real backend behind it (no take-over action) —
// omitted rather than shown with fake data; the channel filter is gone too
// since every real dialog comes from the same one channel (the site widget)
// right now, nothing to filter by yet.
function Dialogs({ setView, onOpenDeal }: { setView: (v: View) => void; onOpenDeal: (dealId: string) => void }) {
  const [dialogs, setDialogs] = useState<DialogListItem[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [conversation, setConversation] = useState<DialogDetail | null>(null);
  const [filter, setFilter] = useState<"all" | "lead" | "human">("all");
  const [search, setSearch] = useState("");
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  // On mobile .dialogs-shell drops to a single column and the list is hidden
  // by default (see globals.css) — with the reference's markup that was
  // PERMANENT, not just an initial state: the first dialog auto-selects on
  // load and there was no way back to the list, ever, so a real account with
  // hundreds of dialogs looked like it had exactly one (found live: "почему
  // в диалоги только один диалог?"). This is which of the two panes mobile
  // shows; desktop's CSS ignores it entirely (both panes always shown there).
  const [mobileView, setMobileView] = useState<"list" | "conversation">("list");
  // Bumped whenever the active dialog changes (invalidating any in-flight
  // conversation/summary fetch for the dialog just left) and on every
  // loadSummary call — without this, switching dialogs (or re-requesting a
  // summary) while a fetch for the PREVIOUS dialog is still in flight let its
  // late response silently overwrite what's now shown for a different
  // dialog. Same pattern as PendingEscalationRow's previewRequestId.
  const dialogRequestId = useRef(0);

  useEffect(() => {
    fetchJsonWithRetry<{ dialogs: DialogListItem[] }>("/api/cabinet/dialogs?page=1").then((data) => {
      const list: DialogListItem[] = data?.dialogs ?? [];
      setDialogs(list);
      if (list.length > 0) setActiveId(list[0].id);
    });
  }, []);

  useEffect(() => {
    const requestId = ++dialogRequestId.current;
    if (!activeId) { setConversation(null); setSummary(null); return; }
    setConversation(null);
    setSummary(null);
    fetchJsonWithRetry<DialogDetail>(`/api/cabinet/dialogs/${activeId}`)
      .then((data) => { if (dialogRequestId.current === requestId) setConversation(data); })
      .catch(() => { if (dialogRequestId.current === requestId) setConversation(null); });
    // Reference's AI-résumé is always just THERE, no click to reveal it — and
    // gating it behind a manual button had its own dead end: the button was
    // rendered by `!summary`, so it simply vanished once a summary loaded,
    // with nothing put in its place (found live: "после нажатия на Показать
    // резюме, кнопка вообще исчезает"). Fetching it alongside the
    // conversation itself, on the same request-id guard, matches the
    // reference's always-shown look and removes the dead-end entirely.
    setSummaryLoading(true);
    fetch(`/api/cabinet/dialogs/${activeId}/summary`, { method: "POST" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (dialogRequestId.current === requestId) setSummary(data?.summary || "Не получилось получить резюме."); })
      .catch(() => { if (dialogRequestId.current === requestId) setSummary("Не получилось получить резюме."); })
      .finally(() => { if (dialogRequestId.current === requestId) setSummaryLoading(false); });
  }, [activeId]);

  const visible = (dialogs ?? []).filter((d) => {
    if (filter === "lead" && !d.lead) return false;
    if (filter === "human" && !d.hasUnansweredEscalation) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (d.lead?.name || d.botName || "").toLowerCase().includes(q) || (d.lastMessagePreview || "").toLowerCase().includes(q);
  });
  const active = (dialogs ?? []).find((d) => d.id === activeId) ?? null;

  return <div className="dialogs-shell" data-mobile-view={mobileView}>
    <aside className="dialog-list">
      <div className="dialog-tools"><div className="search-field"><Search /><input placeholder="Поиск по диалогам" value={search} onChange={(e) => setSearch(e.target.value)} /></div></div>
      <div className="filter-chips">
        <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>Все</button>
        <button className={filter === "lead" ? "active" : ""} onClick={() => setFilter("lead")}>С заявкой</button>
        <button className={filter === "human" ? "active" : ""} onClick={() => setFilter("human")}>Нужен человек</button>
      </div>
      {dialogs === null ? <div className="dialogs-empty-conv">Загружаю…</div> : visible.length === 0 ? <div className="dialogs-empty-conv">{dialogs.length === 0 ? "Диалогов пока нет." : "Ничего не нашлось."}</div> : visible.map((d) => {
        const title = d.lead?.name || d.botName || "Диалог";
        return <button className={`dialog-row ${d.id === activeId ? "active" : ""}`} key={d.id} onClick={() => { setActiveId(d.id); setMobileView("conversation"); }}>
          <span className="dialog-avatar">{title.trim().slice(0, 1).toUpperCase()}</span>
          <span><b>{title}</b><small>{d.lastMessagePreview || "—"}{d.hasUnansweredEscalation && <span className="dialog-row-escalation-badge">ждёт ответа</span>}</small></span>
          <time>{fmtDialogDate(d.updatedAt)}</time>
        </button>;
      })}
    </aside>
    <section className="conversation">
      {!active ? <div className="dialogs-empty-conv">Выберите диалог слева</div> : <>
        <div className="conversation-head">
          <button className="conversation-back icon-button" onClick={() => setMobileView("list")}><ArrowLeft /></button>
          <div className="conversation-title"><b>{active.lead?.name || active.botName || "Диалог"}</b><span><i /> {active.botName} · {fmtDialogDate(active.updatedAt)}</span></div>
          <div>{active.hasUnansweredEscalation ? <StatusPill tone="orange">Ждёт ответа</StatusPill> : active.lead ? <StatusPill>Заявка получена</StatusPill> : null}<button className="icon-button"><MoreHorizontal /></button></div>
        </div>
        {active.dealTitle && <div className="conversation-context"><span><Globe2 /></span><p><b>Сделка в CRM: {active.dealTitle}</b><small>{active.lead?.name || active.lead?.phone || active.lead?.email || ""}</small></p><button onClick={() => { if (active.dealId) onOpenDeal(active.dealId); setView("crm"); }}>Открыть в CRM <ExternalLink /></button></div>}
        <div className="messages">
          {!conversation ? <div className="dialogs-empty-conv">Загружаю…</div> : conversation.messages.map((m) => (
            <div className={`message ${m.role === "assistant" ? "bot-message" : "client-message"}`} key={m.id}>
              {m.role === "assistant" && <span className="mini-bot"><Bot /></span>}
              <p>{m.content}</p>
              <small>{fmtMessageTime(m.createdAt)} МСК</small>
            </div>
          ))}
        </div>
        <div className="conversation-foot">
          <div><ClipboardCheck /><span><b>AI-резюме</b>
            <small>{summary ?? (summaryLoading ? "Готовлю резюме…" : "Резюме недоступно.")}</small>
          </span></div>
          {(active.lead || active.dealTitle) && <Button variant="outline" onClick={() => { if (active.dealId) onOpenDeal(active.dealId); setView("crm"); }}>Открыть лид <ArrowRight /></Button>}
        </div>
      </>}
    </section>
  </div>;
}

// Real widget, not a mockup: same /cabinet/test-widget-preview.html iframe
// the old cabinet embedded (real widget.js, data-preview="true" — actual
// launcher/teaser/chat, actual bot replies, nothing hand-drawn). "Улучшить
// ответ" (per-message correction) isn't wired here yet — that lives on the
// real message bubbles widget.js renders inside the iframe, which this page
// doesn't reach into; flagged as a follow-up rather than faked.
function Training({ me }: { me: CabinetMe }) {
  const [copied, setCopied] = useState(false);
  const token = me?.bot?.widgetToken;
  // autoopen=1 only from here — the legacy cabinet embeds this same shared
  // page in a wider pane where auto-opening would recreate the exact
  // "second, nested chat window" bug this flag is meant to fix (see
  // test-widget-preview.html's own comment). This box matches the reference
  // prototype's own 510px width (.widget-preview) — full-screen "the box IS
  // the chat" behavior comes from widget.js's explicit data-force-fullscreen
  // flag (set only when ?autoopen=1), not from staying under its mobile
  // width breakpoint.
  const previewSrc = token ? `/cabinet/test-widget-preview.html?token=${encodeURIComponent(token)}&autoopen=1` : undefined;
  const copyLink = () => {
    if (!previewSrc) return;
    navigator.clipboard.writeText(`${window.location.origin}${previewSrc}`).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return <div className="training-layout">
    <section className="training-guide">
      <span className="section-label">Тестовая среда</span>
      <h2>Поговорите с ботом как клиент</h2>
      <p>Это точная копия виджета на сайте. Тестовые сообщения не влияют на аналитику.</p>
      <div className="tip-card"><WandSparkles /><div><b>Как обучать быстрее</b><span>Под ответом бота нажмите «👎 Плохой ответ?» и добавьте правильную информацию — бот запомнит её сразу.</span></div></div>
      <div className="share-test"><Users /><div><b>Дать доступ коллеге</b><span>Без входа в личный кабинет</span></div><Button variant="outline" onClick={copyLink} disabled={!previewSrc}>{copied ? "Скопировано" : "Скопировать ссылку"}</Button></div>
    </section>
    <section className="widget-preview">
      {previewSrc ? <iframe src={previewSrc} title="Чат с ботом" style={{ width: "100%", height: "100%", border: 0 }} /> : <div className="dialogs-empty-conv">Загружаю…</div>}
    </section>
  </div>;
}

const testGroups: Array<[string, string, number, number, React.ElementType]> = [
  ["Продажи", "Цены, подбор и следующий шаг", 8, 8, Target],
  ["Возражения", "Дорого, сравнение и сомнения", 7, 6, MessageSquareText],
  ["Знания", "Доставка, гарантия и оплата", 9, 8, BookOpen],
  ["Сложные ситуации", "Не по теме, грубость и попытка взлома", 6, 6, ShieldCheck],
  ["Сбор заявки", "Контакты, согласие и неполные данные", 8, 7, Inbox],
  ["Виджет", "Приветствие и быстрые подсказки", 10, 9, SlidersHorizontal],
];

function AutoTests() {
  const [running, setRunning] = useState(false);
  return <div className="tests-page"><section className="test-overview panel"><div className="test-gauge"><svg viewBox="0 0 108 108"><circle cx="54" cy="54" r="45"/><circle className="score" cx="54" cy="54" r="45"/></svg><strong>92%</strong><small>качество</small></div><div><span className="section-label">Последняя проверка · сегодня, 12:18</span><h2>44 из 48 сценариев пройдены</h2><p>Бот готов к реальному трафику. Три ответа стоит уточнить, один сценарий требует исправления до запуска.</p><div className="test-summary"><StatusPill>44 пройдено</StatusPill><StatusPill tone="orange">3 уточнить</StatusPill><StatusPill tone="gray">1 исправить</StatusPill></div></div><Button className="primary-action" onClick={() => { setRunning(true); setTimeout(() => setRunning(false), 1800); }}>{running ? <><Activity />Проверяем…</> : <><TestTube2 />Запустить 48 тестов</>}</Button></section>
  <div className="test-layout"><section className="test-groups">{testGroups.map(([name,desc,total,passed,Icon]) => <article className="test-group" key={String(name)}><span className="test-group-icon"><Icon /></span><div><b>{name}</b><small>{desc}</small><Progress value={Number(passed)/Number(total)*100}/></div><strong>{String(passed)}/{String(total)}</strong><button><ArrowRight /></button></article>)}</section><aside className="test-issues panel"><span className="section-label">Приоритет исправления</span><h2>Что мешает качеству</h2><article><span className="issue-index critical">1</span><div><b>Доставка за пределы региона</b><small>В базе нет правила расчёта стоимости.</small><button>Добавить знание</button></div></article><article><span className="issue-index">2</span><div><b>Возражение «у конкурентов дешевле»</b><small>Ответ слишком общий и не раскрывает ценность.</small><button>Улучшить ответ</button></div></article><article><span className="issue-index">3</span><div><b>Невалидный номер телефона</b><small>Бот не просит проверить одну цифру.</small><button>Настроить правило</button></div></article></aside></div></div>;
}

// Real data from /api/cabinet/knowledge (see KnowledgeService.list) — this
// used to be a fixed 4-row demo array shown to EVERY company regardless of
// account, so a real client's real cabinet always showed the same "Бани
// Викинг" fixtures instead of their own knowledge base (found live, on
// chat.glavinstrument.com: "База знаний" showed demo content, not
// GlavInstrument's own approved facts). Also wires up AddKnowledgeSheet's
// four source buttons, which used to render but do nothing on click.
type KnowledgeEntry = {
  id: string;
  question: string | null;
  answer: string;
  source: string;
  moderationStatus: "pending" | "approved" | "rejected";
  fileName: string | null;
  createdAt: string;
};

// KnowledgeSource enum values (backend/prisma/schema.prisma) mapped to the
// short label the reference design's "Источник" column expects.
const KNOWLEDGE_SOURCE_LABELS: Record<string, string> = {
  manual: "Вручную", telegram: "Telegram", test_chat: "Тест-чат", site: "Сайт", bulk: "Текст", instruction: "Вручную", correction: "Тест-чат",
};

type KnowledgeStep = "site" | "file" | "text" | "qa" | null;

function AddKnowledgeSheet({ children, onAdded }: { children: React.ReactNode; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<KnowledgeStep>(null);
  const [siteUrl, setSiteUrl] = useState("");
  const [bulkText, setBulkText] = useState("");
  const [qaQuestion, setQaQuestion] = useState("");
  const [qaAnswer, setQaAnswer] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileTitle, setFileTitle] = useState("");
  const [fileDescription, setFileDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setStep(null); setSiteUrl(""); setBulkText(""); setQaQuestion(""); setQaAnswer("");
    setFile(null); setFileTitle(""); setFileDescription(""); setError(null); setSubmitting(false);
  };
  const close = () => { setOpen(false); reset(); };

  // Shared by all 4 submit handlers below: same "disable button, clear old
  // error, reload the real list, close and reset the sheet" shape — only
  // the actual request (and its own validation-failure message) differs.
  const submit = (request: () => Promise<Response>, failureMessage: string) => {
    setSubmitting(true);
    setError(null);
    request()
      .then((r) => (r.ok ? r : Promise.reject(r)))
      .then(() => { onAdded(); close(); })
      .catch(() => setError(failureMessage))
      .finally(() => setSubmitting(false));
  };

  const submitSite = () => submit(
    () => fetch("/api/cabinet/knowledge/site", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: siteUrl.trim() }) }),
    "Не получилось загрузить страницу — проверьте ссылку.",
  );
  const submitText = () => submit(
    () => fetch("/api/cabinet/knowledge/bulk", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: bulkText.trim() }) }),
    "Не получилось обработать текст.",
  );
  const submitQa = () => submit(
    () => fetch("/api/cabinet/knowledge/article", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: qaQuestion.trim(), body: qaAnswer.trim() }) }),
    "Не получилось сохранить запись.",
  );
  const submitFile = () => {
    const form = new FormData();
    form.append("file", file as File);
    form.append("title", fileTitle.trim());
    form.append("description", fileDescription.trim());
    submit(
      () => fetch("/api/cabinet/knowledge/file", { method: "POST", body: form }),
      "Не получилось загрузить файл — проверьте тип (PDF, Word, изображение) и размер (до 15 МБ).",
    );
  };

  const back = () => { setStep(null); setError(null); };

  return <Sheet open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset(); }}>
    <SheetTrigger asChild>{children}</SheetTrigger>
    <SheetContent className="knowledge-sheet">
      <SheetHeader><SheetTitle>Добавить знания</SheetTitle><SheetDescription>Выберите удобный источник. Перед публикацией записи можно проверить.</SheetDescription></SheetHeader>
      {step === null && <div className="source-options">
        <button onClick={() => setStep("site")}><Link2 /><span><b>Добавить сайт</b><small>Импортировать страницы по ссылке</small></span><ArrowRight /></button>
        <button onClick={() => setStep("file")}><FileUp /><span><b>Загрузить файл</b><small>PDF, Word или изображение</small></span><ArrowRight /></button>
        <button onClick={() => setStep("text")}><Database /><span><b>Вставить текст</b><small>Инструкция, статья или ответы</small></span><ArrowRight /></button>
        <button onClick={() => setStep("qa")}><BookOpen /><span><b>Вопрос и ответ</b><small>Добавить одну точную запись</small></span><ArrowRight /></button>
      </div>}
      {step === "site" && <div className="prototype-form">
        <label><span>Ссылка на страницу</span><input value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)} placeholder="https://" /></label>
        {error && <p className="form-error">{error}</p>}
        <SheetFooter><Button className="primary-action" disabled={siteUrl.trim().length < 3 || submitting} onClick={submitSite}>{submitting ? "Загружаю…" : "Импортировать"}</Button><Button variant="outline" onClick={back}>Назад</Button></SheetFooter>
      </div>}
      {step === "file" && <div className="prototype-form">
        <label><span>Файл</span><input type="file" accept=".pdf,.doc,.docx,image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
        <label><span>Название</span><input value={fileTitle} onChange={(e) => setFileTitle(e.target.value)} placeholder="Например, прайс-лист" /></label>
        <label><span>Когда его показывать (необязательно)</span><textarea value={fileDescription} onChange={(e) => setFileDescription(e.target.value)} placeholder="Опишите, что в файле и в каком случае его стоит прислать посетителю" /></label>
        {error && <p className="form-error">{error}</p>}
        <SheetFooter><Button className="primary-action" disabled={!file || !fileTitle.trim() || submitting} onClick={submitFile}>{submitting ? "Загружаю…" : "Загрузить"}</Button><Button variant="outline" onClick={back}>Назад</Button></SheetFooter>
      </div>}
      {step === "text" && <div className="prototype-form">
        <label><span>Текст</span><textarea value={bulkText} onChange={(e) => setBulkText(e.target.value)} placeholder="Вставьте цены, условия или ответы на вопросы — ИИ сам разобьёт текст на записи" /></label>
        {error && <p className="form-error">{error}</p>}
        <SheetFooter><Button className="primary-action" disabled={bulkText.trim().length < 10 || submitting} onClick={submitText}>{submitting ? "Обрабатываю…" : "Добавить"}</Button><Button variant="outline" onClick={back}>Назад</Button></SheetFooter>
      </div>}
      {step === "qa" && <div className="prototype-form">
        <label><span>Вопрос</span><input value={qaQuestion} onChange={(e) => setQaQuestion(e.target.value)} placeholder="Какой вопрос задают посетители?" /></label>
        <label><span>Ответ</span><textarea value={qaAnswer} onChange={(e) => setQaAnswer(e.target.value)} placeholder="Точный ответ бота" /></label>
        {error && <p className="form-error">{error}</p>}
        <SheetFooter><Button className="primary-action" disabled={!qaQuestion.trim() || !qaAnswer.trim() || submitting} onClick={submitQa}>{submitting ? "Сохраняю…" : "Сохранить"}</Button><Button variant="outline" onClick={back}>Назад</Button></SheetFooter>
      </div>}
    </SheetContent>
  </Sheet>;
}

function Knowledge() {
  const [entries, setEntries] = useState<KnowledgeEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "qa" | "instruction">("all");
  // Same guard as dialogRequestId/openDealRequestId elsewhere in this file —
  // without it, a reload() triggered by adding a new entry could resolve
  // AFTER an in-flight moderate()/remove() optimistic update and silently
  // overwrite that row back to its pre-click state.
  const listRequestId = useRef(0);
  const reload = () => {
    const requestId = ++listRequestId.current;
    fetchJsonWithRetry<KnowledgeEntry[]>("/api/cabinet/knowledge").then((data) => {
      if (listRequestId.current === requestId) setEntries(data ?? []);
    });
  };
  useEffect(() => { reload(); }, []);

  const total = entries?.length ?? 0;
  const qaCount = (entries ?? []).filter((e) => e.source !== "instruction").length;
  const approvedCount = (entries ?? []).filter((e) => e.moderationStatus === "approved").length;

  const filtered = (entries ?? []).filter((e) => {
    if (typeFilter === "instruction" && e.source !== "instruction") return false;
    if (typeFilter === "qa" && e.source === "instruction") return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (e.question ?? "").toLowerCase().includes(q) || e.answer.toLowerCase().includes(q);
  });

  const moderate = (id: string, status: "approved" | "rejected") => {
    // Optimistic — the owner is reviewing a short queue one row at a time;
    // waiting for the round-trip before the pill/buttons update would make
    // every click feel like it didn't register. Bumping listRequestId here
    // (not just on reload() itself) invalidates any reload() GET already in
    // flight from before this click — without it, that GET could resolve
    // right after this optimistic update with the pre-moderation data and
    // silently revert this row back to "pending".
    listRequestId.current++;
    setEntries((prev) => prev && prev.map((e) => (e.id === id ? { ...e, moderationStatus: status } : e)));
    fetch(`/api/cabinet/knowledge/${id}/moderate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) })
      .then((r) => { if (!r.ok) throw new Error(); })
      .catch(() => reload());
  };
  const remove = (id: string) => {
    if (!window.confirm("Удалить запись из базы знаний? Бот перестанет её использовать.")) return;
    listRequestId.current++;
    setEntries((prev) => prev && prev.filter((e) => e.id !== id));
    fetch(`/api/cabinet/knowledge/${id}`, { method: "DELETE" })
      .then((r) => { if (!r.ok) throw new Error(); })
      .catch(() => reload());
  };

  return <div className="knowledge-page">
    <div className="knowledge-summary">
      <div><Database /><span><b>{total} записей</b><small>{entries === null ? "Загружаю…" : `${approvedCount} проверены и используются ботом`}</small></span></div>
      <div className="summary-segment"><span style={{ width: total ? `${Math.round((approvedCount / total) * 100)}%` : "0%" }} /><small>{qaCount} вопросов и ответов</small></div>
      <AddKnowledgeSheet onAdded={reload}><Button className="primary-action"><Plus />Добавить знания</Button></AddKnowledgeSheet>
    </div>
    <div className="knowledge-toolbar">
      <div className="search-field"><Search /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти по смыслу или словам" /></div>
      <div className="filter-chips">
        <button className={typeFilter === "all" ? "active" : ""} onClick={() => setTypeFilter("all")}>Все {total}</button>
        <button className={typeFilter === "qa" ? "active" : ""} onClick={() => setTypeFilter("qa")}>Вопросы {qaCount}</button>
        <button className={typeFilter === "instruction" ? "active" : ""} onClick={() => setTypeFilter("instruction")}>Инструкции {total - qaCount}</button>
      </div>
    </div>
    <div className="knowledge-table">
      <div className="table-head"><span>Запись</span><span>Тип</span><span>Источник</span><span>Статус</span><span /></div>
      {entries === null ? <div className="dialogs-empty-conv">Загружаю…</div>
        : filtered.length === 0 ? <div className="dialogs-empty-conv">{total === 0 ? "База знаний пока пуста — добавьте первую запись." : "Ничего не нашлось."}</div>
        : filtered.map((e) => <div className="knowledge-row" key={e.id}>
          <div><b>{e.question || e.fileName || "Запись без вопроса"}</b><small>{e.answer}</small></div>
          <StatusPill tone="blue">{e.source === "instruction" ? "Инструкция" : "Вопрос / ответ"}</StatusPill>
          <span className="source-cell">{KNOWLEDGE_SOURCE_LABELS[e.source] ?? e.source}</span>
          {e.moderationStatus === "pending"
            ? <div className="kb-row-actions"><button className="kb-mini-btn approve" aria-label="Одобрить запись" onClick={() => moderate(e.id, "approved")}><Check /></button><button className="kb-mini-btn reject" aria-label="Отклонить запись" onClick={() => moderate(e.id, "rejected")}><X /></button></div>
            : <StatusPill tone={e.moderationStatus === "rejected" ? "gray" : "green"}>{e.moderationStatus === "rejected" ? "Отклонена" : <><Check /> Живая</>}</StatusPill>}
          <button className="icon-button" aria-label="Удалить запись" onClick={() => remove(e.id)}><MoreHorizontal /></button>
        </div>)}
    </div>
  </div>;
}

function WidgetSettings() {
  const [color, setColor] = useState("#8298ff"); const [saved, setSaved] = useState(false);
  return <div className="settings-layout"><section className="settings-form"><div className="settings-section"><div className="section-title"><span><Bot /></span><div><h2>Личность бота</h2><p>То, как он представляется посетителю</p></div></div><label><span>Название компании</span><input defaultValue="Бани Викинг" /></label><div className="two-fields"><label><span>Имя бота</span><input defaultValue="Алексей" /></label><label><span>Голос</span><Select defaultValue="male"><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="male">Мужской</SelectItem><SelectItem value="female">Женский</SelectItem></SelectContent></Select></label></div></div><div className="settings-section"><div className="section-title"><span><Sparkles /></span><div><h2>Внешний вид</h2><p>Цвет и расположение виджета</p></div></div><div className="color-field"><span>Акцентный цвет</span><div>{["#8298ff", "#c8ff4d", "#ff9d6c", "#182b43"].map(c => <button aria-label={`Цвет ${c}`} className={color === c ? "active" : ""} style={{ background: c }} onClick={() => setColor(c)} key={c} />)}<input value={color} onChange={e => setColor(e.target.value)} /></div></div><label><span>Расположение</span><Select defaultValue="right"><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="right">Справа внизу</SelectItem><SelectItem value="left">Слева внизу</SelectItem></SelectContent></Select></label></div><div className="settings-section"><div className="section-title"><span><TestTube2 /></span><div><h2>Приветствия</h2><p>Сравнивайте варианты в A/B/C/D-тесте</p></div></div><div className="greeting"><b>A</b><textarea defaultValue="Здравствуйте! Помогу подобрать баню под ваши задачи." /><StatusPill>Активно</StatusPill></div><button className="add-greeting"><Plus /> Добавить вариант</button></div><Button className="save-button" style={{ background: saved ? "#153526" : undefined }} onClick={() => { setSaved(true); setTimeout(() => setSaved(false), 1800); }}>{saved ? <><Check />Сохранено</> : "Сохранить изменения"}</Button></section><aside className="live-preview"><div className="preview-label"><span><i /> Предпросмотр</span><button><ExternalLink /></button></div><div className="preview-site"><div className="preview-nav" /><div className="preview-copy"><i /><i /><i /></div><div className="floating-widget" style={{ ["--widget-accent" as string]: color }}><div className="widget-head"><span className="bot-avatar">А</span><div><b>Алексей</b><small><i /> На связи</small></div></div><p>Здравствуйте! Помогу подобрать баню под ваши задачи.</p><div className="widget-input"><span>Напишите сообщение</span><button><Send /></button></div></div></div></aside></div>;
}

function Installation() {
  const [copied, setCopied] = useState(false);
  return <div className="install-layout"><article className="panel install-main"><div className="install-icon"><Link2 /></div><span className="section-label">Одна строка кода</span><h2>Установите готового бота на сайт</h2><p>Скопируйте код и добавьте его перед закрывающим тегом <code>&lt;/body&gt;</code>. Бот появится на сайте сразу после публикации.</p><div className="code-box"><code>&lt;script src=&quot;https://chat.glavinstrument.com/widget.js&quot; data-bot=&quot;your-bot&quot;&gt;&lt;/script&gt;</code><button onClick={() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? <Check /> : <Copy />}{copied ? "Скопировано" : "Скопировать"}</button></div><div className="platforms"><span>Инструкции для:</span>{["Tilda", "WordPress", "Wix", "Другой сайт"].map(p => <button key={p}>{p}</button>)}</div></article><aside className="panel launch-help"><Headphones /><h3>Поможем с установкой</h3><p>Если не хотите разбираться с кодом, отправьте нам доступ или контакт разработчика.</p><Button variant="outline">Написать в поддержку</Button></aside></div>;
}

function Integrations() {
  const [telegram, setTelegram] = useState(false); const [leads, setLeads] = useState(true);
  return <div className="integrations-page"><div className="integration-grid"><article className="integration-card featured"><div className="integration-logo telegram"><Send /></div><StatusPill tone={telegram ? "green" : "gray"}>{telegram ? "Подключено" : "Не подключено"}</StatusPill><h3>Telegram</h3><p>Сложные вопросы, новые заявки и возможность быстро подключиться к разговору.</p><Button className="primary-action" data-live onClick={() => setTelegram(!telegram)}>{telegram ? "Открыть настройки" : "Подключить Telegram"}</Button></article><article className="integration-card"><div className="integration-logo bitrix">B24</div><StatusPill tone="gray">Не подключено</StatusPill><h3>Bitrix24</h3><p>Создавайте сделки автоматически и передавайте историю диалога.</p><Button variant="outline">Подключить</Button></article><article className="integration-card"><div className="integration-logo amo">amo</div><StatusPill tone="gray">Не подключено</StatusPill><h3>amoCRM</h3><p>Заявки, этапы воронки и обратная синхронизация статусов.</p><Button variant="outline">Подключить</Button></article></div><section className="panel notification-settings"><div className="panel-head"><div><span className="section-label">Уведомления</span><h2>Что отправлять в Telegram</h2></div></div><div className="switch-row"><div><Target /><span><b>Новые заявки</b><small>Контакт, запрос и ссылка на диалог</small></span></div><Switch checked={leads} onCheckedChange={setLeads} /></div><div className="switch-row"><div><AlertCircle /><span><b>Сложные вопросы</b><small>Когда бот не уверен в ответе</small></span></div><Switch defaultChecked /></div></section></div>;
}

const leadItems = [
  { name: "Анна", contact: "+7 ••• •• 41", request: "Ищет баню для семьи из четырёх человек, круглогодичное использование, выбирает 6 или 8 м.", next: "Позвонить и уточнить регион", source: "Яндекс Реклама", status: "Новый", time: "12:41" },
  { name: "Михаил", contact: "+7 ••• •• 08", request: "Запросил стоимость модели 6 м с доставкой и установкой.", next: "Отправить расчёт", source: "Прямой заход", status: "В работе", time: "10:16" },
  { name: "Елена", contact: "+7 ••• •• 76", request: "Выбрала модель 6 м, готова согласовать комплектацию и договор.", next: "Подготовить договор", source: "Социальные сети", status: "Успешно", time: "вчера" },
];

function Leads({ setView }: { setView: (v: View) => void }) {
  const [status, setStatus] = useState("Все");
  const visibleLeads = status === "Все" ? leadItems : leadItems.filter(item => item.status === status);
  return <div className="leads-page"><section className="leads-summary"><article><span className="lead-icon blue"><Inbox /></span><div><small>Всего лидов</small><b>119</b><em>+18 за неделю</em></div></article><article><span className="lead-icon lime"><Flame /></span><div><small>Новые</small><b>7</b><em>Нужна реакция</em></div></article><article><span className="lead-icon violet"><Headphones /></span><div><small>В работе</small><b>84</b><em>70,6% обработано</em></div></article><article><span className="lead-icon green"><Check /></span><div><small>Успешно</small><b>28</b><em>23,5% от всех</em></div></article></section><section className="leads-board"><div className="leads-toolbar"><div className="search-field"><Search /><input placeholder="Имя, контакт или запрос" /></div><div className="filter-chips">{["Все", "Новый", "В работе", "Успешно"].map(item => <button data-live className={status === item ? "active" : ""} onClick={() => setStatus(item)} key={item}>{item}</button>)}</div><button className="filter-button"><ListFilter />Период: неделя</button></div><div className="leads-table"><div className="lead-table-head"><span>Лид</span><span>Что нужно клиенту</span><span>Следующий шаг</span><span>Источник</span><span>Статус</span><span /></div>{visibleLeads.map((lead, index) => <article className="lead-row" key={lead.name}><div className="lead-person"><span className="dialog-avatar">{lead.name[0]}</span><p><b>{lead.name}</b><small>{lead.contact} · {lead.time}</small></p></div><p className="lead-summary-cell"><BrainCircuit /><span>{lead.request}</span></p><p className="next-step"><Clock3 /><span>{lead.next}</span></p><span className="lead-source"><Globe2 />{lead.source}</span><StatusPill tone={lead.status === "Успешно" ? "green" : lead.status === "Новый" ? "orange" : "blue"}>{lead.status}</StatusPill><button className="lead-open" data-live onClick={() => setView(index === 0 ? "dialogs" : "crm")} aria-label={`Открыть лид ${lead.name}`}><ArrowRight /></button></article>)}</div></section><div className="leads-note"><ShieldCheck /><span><b>Демо-данные</b><small>Контакты скрыты. В рабочем кабинете лид открывается вместе с диалогом, источником и полной историей.</small></span></div></div>;
}

type DealStage = { id: string; name: string; color: string; order: number; isWon: boolean; isLost: boolean };
type DealSummary = {
  id: string; title: string; name: string | null; phone: string | null; email: string | null;
  amount: number | null; currency: string | null; stageId: string; assignedUserId: string | null;
  assignedUserName: string | null; source: string; createdAt: string; updatedAt: string;
  customFields: Record<string, string | null>;
};
type DealActivityItem = { id: string; kind: string; text: string; authorName: string | null; createdAt: string };
type DealTaskItem = { id: string; title: string; dueDate: string | null; completedAt: string | null; createdAt: string };
type DealDetail = DealSummary & { dialogId: string | null; activities: DealActivityItem[]; tasks: DealTaskItem[] };
type CustomFieldDef = { id: string; key: string; label: string; type: string; options?: string[] };
type TeamMember = { id: string; name: string | null; email: string };
type Board = { stages: DealStage[]; deals: DealSummary[] };

function fmtDealDate(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function initialOfName(name: string | null | undefined): string {
  return (name || "?").trim().charAt(0).toUpperCase() || "?";
}

function CRM({ me, dealToOpen, onDealOpened }: { me: CabinetMe; dealToOpen: string | null; onDealOpened: () => void }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [customFieldDefs, setCustomFieldDefs] = useState<CustomFieldDef[]>([]);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [openDeal, setOpenDeal] = useState<DealDetail | null>(null);
  const [search, setSearch] = useState("");
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverStage, setDragOverStage] = useState<string | null>(null);
  const canSeeAllDeals = me?.companyRole === "owner" || me?.companyRole === "manager";
  // Same guard as dialogRequestId/previewRequestId elsewhere in this file —
  // openDealById had none (found by code review): clicking deal A then
  // quickly clicking deal B before A's (possibly still-retrying) fetch
  // resolves let A's late response silently overwrite the panel back to A
  // after the owner had already moved on to B.
  const openDealRequestId = useRef(0);

  const loadBoard = () => fetchJsonWithRetry<Board>("/api/cabinet/deals").then((data) => data && setBoard(data));

  useEffect(() => {
    loadBoard();
    fetchJsonWithRetry<CustomFieldDef[]>("/api/cabinet/deals/custom-fields/list").then((data) => setCustomFieldDefs(data ?? []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Separate effect keyed on canSeeAllDeals itself, not folded into the
  // mount-only effect above — `me` (and so canSeeAllDeals) is still null on
  // the very first render, loading in via its own retried fetch elsewhere;
  // an effect that only checked canSeeAllDeals once at mount would find it
  // false at that instant and never re-fetch once `me` actually populates,
  // leaving the "Ответственный" dropdown permanently stuck on "Не назначено"
  // for an owner/manager who opened CRM before /api/cabinet/me resolved.
  useEffect(() => {
    if (canSeeAllDeals) fetchJsonWithRetry<TeamMember[]>("/api/cabinet/team").then((data) => setTeamMembers(data ?? []));
  }, [canSeeAllDeals]);

  const openDealById = (id: string) => {
    const requestId = ++openDealRequestId.current;
    fetchJsonWithRetry<DealDetail>(`/api/cabinet/deals/${id}`).then((data) => {
      if (data && openDealRequestId.current === requestId) setOpenDeal(data);
    });
  };

  // "Открыть лид" (Диалоги) hands off a dealId through shared state instead
  // of a full page navigation (the two used to be separate apps — crm.html
  // was a standalone static page — so this went through window.location.href
  // + a ?deal= query param the static page read on load; now that CRM lives
  // in the same React tree, it's just a normal cross-view prop).
  useEffect(() => {
    if (dealToOpen) { openDealById(dealToOpen); onDealOpened(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealToOpen]);

  const moveDealToStage = (dealId: string, stageId: string) => {
    fetch(`/api/cabinet/deals/${dealId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stageId }) })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((updated) => { loadBoard(); if (openDeal?.id === dealId) setOpenDeal(updated); })
      .catch(() => loadBoard());
  };

  const createDeal = () => {
    const title = window.prompt("Название новой сделки:");
    if (!title) return;
    fetch("/api/cabinet/deals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }) })
      .then((r) => { if (r.ok) loadBoard(); });
  };

  const visibleDeals = (board?.deals ?? []).filter((d) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [d.title, d.name, d.phone, d.email].filter(Boolean).some((v) => (v as string).toLowerCase().includes(q));
  });

  return <div className="crm-page">
    <div className="crm-toolbar">
      <div className="search-field"><Search /><input placeholder="Поиск по сделкам" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
      <button className="filter-button"><ListFilter /> Фильтры</button>
      <Button className="primary-action" onClick={createDeal}><Plus />Новая сделка</Button>
    </div>
    {!board ? <div className="dialogs-empty-conv">Загружаю…</div> : <div className="kanban kanban-dynamic">
      {board.stages.map((stage) => {
        const dealsInStage = visibleDeals.filter((d) => d.stageId === stage.id);
        return <section className={`kanban-col ${dragOverStage === stage.id ? "drag-over" : ""}`} key={stage.id}
          onDragOver={(e) => { e.preventDefault(); setDragOverStage(stage.id); }}
          onDragLeave={() => setDragOverStage((s) => (s === stage.id ? null : s))}
          onDrop={(e) => { e.preventDefault(); setDragOverStage(null); if (draggingId) moveDealToStage(draggingId, stage.id); }}>
          <div className="kanban-head kanban-head-2col"><span><i className="col-dot" style={{ background: stage.color }} />{stage.name}</span><b>{dealsInStage.length}</b></div>
          <div className="kanban-stack">
            {dealsInStage.map((deal) => <article className={`deal-card ${draggingId === deal.id ? "dragging" : ""}`} key={deal.id}
              draggable
              onDragStart={() => setDraggingId(deal.id)}
              onDragEnd={() => setDraggingId(null)}
              onClick={() => openDealById(deal.id)}>
              <div><span className="deal-avatar">{initialOfName(deal.name || deal.title)}</span>{deal.assignedUserName && <StatusPill tone="blue">{deal.assignedUserName}</StatusPill>}</div>
              <h3>{deal.title}</h3>
              <p>{[deal.name, deal.phone].filter(Boolean).join(" · ") || "—"}</p>
              <small>{fmtDealDate(deal.createdAt)}</small>
              <div className="deal-foot"><span>{deal.amount ? `${deal.amount.toLocaleString("ru-RU")} ${deal.currency || ""}` : ""}</span></div>
            </article>)}
            {dealsInStage.length === 0 && <div className="drop-empty">Перетащите сделку сюда</div>}
          </div>
        </section>;
      })}
    </div>}
    {openDeal && <DealPanel
      deal={openDeal}
      stages={board?.stages ?? []}
      customFieldDefs={customFieldDefs}
      teamMembers={teamMembers}
      canReassign={canSeeAllDeals}
      onClose={() => { setOpenDeal(null); loadBoard(); }}
      onChanged={(updated) => { setOpenDeal(updated); loadBoard(); }}
    />}
  </div>;
}

// Deal detail panel — no reference equivalent at all (the prototype's own
// CRM() is static demo cards with no drawer/panel concept). Left column is
// static (client card, stage, fields) — glance-and-forget info that rarely
// changes mid-session; right column is a live timeline: open tasks (with a
// real checkbox — completing one is its own action, not just a note) pinned
// above the chronological notes/history feed, matching how the owner
// actually described wanting it read: "слева статичная информация, справа
// таймлайн — задачи, заметки".
function DealPanel({ deal, stages, customFieldDefs, teamMembers, canReassign, onClose, onChanged }: {
  deal: DealDetail;
  stages: DealStage[];
  customFieldDefs: CustomFieldDef[];
  teamMembers: TeamMember[];
  canReassign: boolean;
  onClose: () => void;
  onChanged: (updated: DealDetail) => void;
}) {
  const [name, setName] = useState(deal.name || "");
  const [phone, setPhone] = useState(deal.phone || "");
  const [email, setEmail] = useState(deal.email || "");
  const [title, setTitle] = useState(deal.title);
  const [amount, setAmount] = useState(deal.amount != null ? String(deal.amount) : "");
  const [assigneeId, setAssigneeId] = useState(deal.assignedUserId || "");
  const [customFields, setCustomFields] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const f of customFieldDefs) initial[f.key] = deal.customFields[f.key] || "";
    return initial;
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDueDate, setTaskDueDate] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMessages, setDialogMessages] = useState<Array<{ id: string; role: string; content: string }> | null>(null);

  // Re-sync every local field whenever a DIFFERENT deal is opened (new id) —
  // without the id check, moving stage from the pills below (which re-fetches
  // and passes the SAME deal back in via onChanged) would blow away whatever
  // the owner was mid-typing in the title/amount/name fields.
  const dealIdRef = useRef(deal.id);
  useEffect(() => {
    if (dealIdRef.current === deal.id) return;
    dealIdRef.current = deal.id;
    setName(deal.name || ""); setPhone(deal.phone || ""); setEmail(deal.email || "");
    setTitle(deal.title); setAmount(deal.amount != null ? String(deal.amount) : ""); setAssigneeId(deal.assignedUserId || "");
    const initial: Record<string, string> = {};
    for (const f of customFieldDefs) initial[f.key] = deal.customFields[f.key] || "";
    setCustomFields(initial);
    setDialogOpen(false); setDialogMessages(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deal.id]);

  // customFieldDefs loads asynchronously in the parent CRM component and can
  // still be [] at the exact moment this panel first mounts (opened right
  // after the board loaded, before that separate fetch resolves) — the
  // lazy useState initializer above only ever runs once, so without this a
  // deal opened in that narrow window showed no custom field inputs at all
  // until closed and reopened (found by code review). Backfills any newly-
  // available keys without touching ones already being edited.
  useEffect(() => {
    setCustomFields((cf) => {
      let changed = false;
      const next = { ...cf };
      for (const f of customFieldDefs) {
        if (!(f.key in next)) { next[f.key] = deal.customFields[f.key] || ""; changed = true; }
      }
      return changed ? next : cf;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customFieldDefs]);

  const save = () => {
    setSaving(true); setSaveError(null);
    const body: Record<string, unknown> = { title, name, phone, email, amount: amount ? Number(amount) : null, customFields };
    if (canReassign) body.assignedUserId = assigneeId || null;
    fetch(`/api/cabinet/deals/${deal.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then((r) => (r.ok ? r.json() : r.json().then((d) => Promise.reject(new Error(d.message)))))
      .then((updated) => onChanged(updated))
      .catch((err) => setSaveError(err.message || "Ошибка сохранения"))
      .finally(() => setSaving(false));
  };

  // Every action below shares save()'s own saveError surface — none of them
  // had ANY error handling before (found by code review): a failed fetch or
  // a non-ok response (e.g. the deal's visibility changed in another session
  // while this panel was open, so assertDealVisible/assertCanEdit now 404s/
  // 403s) just silently did nothing, looking exactly like success while sibling
  // save() already showed a real error for the identical failure class.
  const reportActionFailure = (action: string) => (err: unknown) => {
    setSaveError(err instanceof Error && err.message ? err.message : `Не получилось: ${action}`);
  };

  const moveStage = (stageId: string) => {
    if (stageId === deal.stageId) return;
    fetch(`/api/cabinet/deals/${deal.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stageId }) })
      .then((r) => (r.ok ? r.json() : r.json().then((d) => Promise.reject(new Error(d.message)))))
      .then((updated) => onChanged(updated))
      .catch(reportActionFailure("сменить стадию"));
  };

  const addNote = () => {
    if (!noteText.trim()) return;
    fetch(`/api/cabinet/deals/${deal.id}/activities`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: noteText.trim() }) })
      .then((r) => (r.ok ? r.json() : r.json().then((d) => Promise.reject(new Error(d.message)))))
      .then((updated) => { onChanged(updated); setNoteText(""); })
      .catch(reportActionFailure("добавить заметку"));
  };

  const addTask = () => {
    if (!taskTitle.trim()) return;
    fetch(`/api/cabinet/deals/${deal.id}/tasks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: taskTitle.trim(), dueDate: taskDueDate || undefined }) })
      .then((r) => (r.ok ? r.json() : r.json().then((d) => Promise.reject(new Error(d.message)))))
      .then((updated) => { onChanged(updated); setTaskTitle(""); setTaskDueDate(""); })
      .catch(reportActionFailure("добавить задачу"));
  };

  const toggleTask = (taskId: string, completed: boolean) => {
    fetch(`/api/cabinet/deals/${deal.id}/tasks/${taskId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ completed }) })
      .then((r) => (r.ok ? r.json() : r.json().then((d) => Promise.reject(new Error(d.message)))))
      .then((updated) => onChanged(updated))
      .catch(reportActionFailure(completed ? "отметить задачу выполненной" : "вернуть задачу"));
  };

  const toggleDialogThread = () => {
    if (dialogOpen) { setDialogOpen(false); return; }
    setDialogOpen(true);
    if (!dialogMessages && deal.dialogId) {
      fetchJsonWithRetry<{ messages: Array<{ id: string; role: string; content: string }> }>(`/api/cabinet/dialogs/${deal.dialogId}`)
        .then((data) => setDialogMessages(data?.messages ?? []));
    }
  };

  const telHref = "tel:" + (deal.phone || "").replace(/[^+\d]/g, "");
  const openTasks = deal.tasks.filter((t) => !t.completedAt);
  const doneTasks = deal.tasks.filter((t) => t.completedAt);

  return <div className="crm-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="crm-panel">
      <div className="crm-panel-header">
        <button type="button" className="crm-panel-close" onClick={onClose}><X /></button>
        <div><h2 className="crm-panel-title">{deal.title}</h2><small>Создано {fmtDealDate(deal.createdAt)}</small></div>
      </div>
      <div className="crm-panel-body">
        <div className="crm-panel-static">
          <div className="crm-client-card">
            <div className="crm-client-avatar">{initialOfName(name)}</div>
            <div className="crm-client-fields">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Имя клиента" />
              <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Телефон" />
              <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" />
            </div>
            {deal.phone && <a className="crm-client-call" href={telHref}><Phone size={16} color="#fff" /></a>}
          </div>
          <div className="crm-stage-pills">
            {stages.map((s) => <button type="button" key={s.id} className={`crm-stage-pill ${s.id === deal.stageId ? "active" : ""}`} style={s.id === deal.stageId ? { background: s.color } : undefined} onClick={() => moveStage(s.id)}>
              <span className="crm-stage-pill-dot" style={{ background: s.id === deal.stageId ? "rgba(255,255,255,.85)" : s.color }} />{s.name}
            </button>)}
          </div>
          <div className="crm-field-row"><label>Название сделки</label><input value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          <div className="crm-field-row"><label>Сумма</label><input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
          {canReassign && <div className="crm-field-row"><label>Ответственный</label><select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
            <option value="">Не назначено</option>
            {teamMembers.map((u) => <option value={u.id} key={u.id}>{u.name || u.email}</option>)}
          </select></div>}
          {customFieldDefs.map((f) => <div className="crm-field-row" key={f.key}><label>{f.label}</label>
            {f.type === "textarea"
              ? <textarea rows={3} value={customFields[f.key] || ""} onChange={(e) => setCustomFields((cf) => ({ ...cf, [f.key]: e.target.value }))} />
              : <input type={f.type === "number" ? "number" : f.type === "date" ? "date" : f.type === "phone" ? "tel" : f.type === "email" ? "email" : "text"} value={customFields[f.key] || ""} onChange={(e) => setCustomFields((cf) => ({ ...cf, [f.key]: e.target.value }))} />}
          </div>)}
          <Button className="primary-action" disabled={saving} onClick={save}>{saving ? "Сохраняю…" : "Сохранить"}</Button>
          {saveError && <small style={{ color: "#d54848", display: "block", marginTop: 6 }}>{saveError}</small>}
        </div>
        <div className="crm-panel-timeline">
          {saveError && <small style={{ color: "#d54848" }}>{saveError}</small>}
          <div className="deal-task-add">
            <input placeholder="Новая задача" value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} />
            <input type="date" value={taskDueDate} onChange={(e) => setTaskDueDate(e.target.value)} style={{ maxWidth: 140 }} />
            <Button variant="outline" onClick={addTask}>Добавить</Button>
          </div>
          {openTasks.length > 0 && <div className="deal-tasks">
            {openTasks.map((t) => <label className="deal-task" key={t.id}>
              <input type="checkbox" checked={false} onChange={() => toggleTask(t.id, true)} />
              <span><span className="deal-task-title">{t.title}</span>{t.dueDate && <span className="deal-task-due"> · до {fmtDealDate(t.dueDate)}</span>}</span>
            </label>)}
          </div>}
          {doneTasks.length > 0 && <div className="deal-tasks">
            {doneTasks.map((t) => <label className="deal-task done" key={t.id}>
              <input type="checkbox" checked={true} onChange={() => toggleTask(t.id, false)} />
              <span className="deal-task-title">{t.title}</span>
            </label>)}
          </div>}
          <div className="crm-field-row"><label>Добавить заметку</label><textarea rows={2} value={noteText} onChange={(e) => setNoteText(e.target.value)} />
            <Button variant="outline" style={{ marginTop: 6 }} onClick={addNote}>Добавить</Button>
          </div>
          <div className="deal-timeline">
            {deal.activities.length === 0 ? <p className="empty">Пока нет записей.</p> : deal.activities.map((a) => <div className={`deal-timeline-item ${a.kind !== "note" ? "system" : ""}`} key={a.id}>
              {a.text}
              <div className="meta">{a.authorName ? `${a.authorName} · ` : ""}{fmtDealDate(a.createdAt)}</div>
            </div>)}
          </div>
          {deal.dialogId && <>
            <button type="button" className="crm-dialog-toggle" onClick={toggleDialogThread}>{dialogOpen ? "Скрыть переписку" : "Показать переписку"}</button>
            {dialogOpen && <div className="crm-dialog-thread">
              {!dialogMessages ? "Загрузка…" : dialogMessages.map((m) => <div className={`crm-dialog-msg ${m.role === "assistant" ? "support" : "client"}`} key={m.id}>{m.content}</div>)}
            </div>}
          </>}
        </div>
      </div>
    </div>
  </div>;
}

type CheckoutChoice = { name: string; detail: string; total: number };

function CheckoutDialog({ choice, onClose }: { choice: CheckoutChoice | null; onClose: () => void }) {
  const [method, setMethod] = useState("sbp");
  const [paid, setPaid] = useState(false);
  return <Dialog open={Boolean(choice)} onOpenChange={open => { if (!open) { setPaid(false); onClose(); } }}><DialogContent className="checkout-dialog"><DialogHeader><DialogTitle>{paid ? "Оплата подтверждена" : "Оформление оплаты"}</DialogTitle><DialogDescription>{paid ? "В рабочем кабинете доступ или баланс обновятся автоматически." : "Проверьте выбранный продукт и способ оплаты."}</DialogDescription></DialogHeader>{paid ? <div className="payment-success"><span><Check/></span><h3>{choice?.name}</h3><p>Демонстрация успешного платежа. Чек и закрывающие документы появятся в истории операций.</p></div> : <><div className="checkout-summary"><div><span>{choice?.name}</span><small>{choice?.detail}</small></div><strong>{choice?.total.toLocaleString("ru-RU")} ₽</strong></div><div className="payment-methods"><span>Способ оплаты</span><button className={method === "sbp" ? "active" : ""} onClick={() => setMethod("sbp")}><Wallet/><span><b>СБП</b><small>Без комиссии</small></span><Check/></button><button className={method === "card" ? "active" : ""} onClick={() => setMethod("card")}><CreditCard/><span><b>Банковская карта</b><small>Мир, Visa или Mastercard</small></span><Check/></button><button className={method === "invoice" ? "active" : ""} onClick={() => setMethod("invoice")}><Building2/><span><b>Счёт для юрлица</b><small>С реквизитами и закрывающими документами</small></span><Check/></button></div></>}<DialogFooter><Button variant="outline" onClick={onClose}>{paid ? "Закрыть" : "Отмена"}</Button>{!paid && <Button className="primary-action" onClick={() => setPaid(true)}>Перейти к оплате <ArrowRight/></Button>}</DialogFooter></DialogContent></Dialog>;
}

function Billing() {
  const [annual, setAnnual] = useState(false);
  const [tokenPack, setTokenPack] = useState(500);
  const [leadPack, setLeadPack] = useState(30);
  const [autoPay, setAutoPay] = useState(true);
  const [choice, setChoice] = useState<CheckoutChoice | null>(null);
  const tokenPrices: Record<number, number> = { 100: 390, 500: 990, 1000: 1490 };
  const unlimitedTotal = annual ? 118800 : 12900;
  const unlimitedMonthly = annual ? 9900 : 12900;
  const leadTotal = leadPack * 149;
  const buy = (name: string, detail: string, total: number) => setChoice({ name, detail, total });
  const included = ["ИИ-чат и база знаний", "Воронка и график конверсии", "Автотесты качества", "CRM и история лидов", "Telegram, Bitrix24 и amoCRM", "Менеджер внедрения и поддержка"];
  return <div className="billing-page"><section className="billing-status"><div><span className="billing-status-icon"><Sparkles/></span><p><small>Сейчас</small><b>Пробный период · все функции открыты</b><span>Осталось 15 дней. Карта не привязана.</span></p></div><button data-live onClick={() => buy("Безлимит", annual ? "12 месяцев, единым платежом" : "1 месяц", unlimitedTotal)}>Продолжить без ограничений <ArrowRight/></button></section><div className="billing-switch"><div><span className="section-label">Три модели оплаты</span><h2>Платите так, как устроен ваш бизнес</h2><p>Функции одинаковы на всех тарифах. Меняется только единица расчёта.</p></div><label><span>Оплата безлимита за год</span><Switch checked={annual} onCheckedChange={setAnnual}/><small>Экономия 36 000 ₽</small></label></div><section className="pricing-grid"><article className="price-card"><div className="price-icon token"><Zap/></div><span className="price-eyebrow">Низкий порог входа</span><h3>Токены</h3><p>Для небольшого или нерегулярного трафика. Баланс не сгорает.</p><div className="price"><b>от 390 ₽</b><span>за пакет токенов</span></div><small className="price-estimate">Стартовый пакет — 100 тыс. токенов*</small><div className="pack-selector">{[100,500,1000].map(pack => <button className={tokenPack === pack ? "active" : ""} onClick={() => setTokenPack(pack)} key={pack}><b>{pack === 1000 ? "1 млн" : `${pack} тыс.`}</b><small>{tokenPrices[pack].toLocaleString("ru-RU")} ₽</small></button>)}</div><Button variant="outline" data-live onClick={() => buy("Пакет токенов", `${tokenPack === 1000 ? "1 млн" : `${tokenPack} тыс.`} AI-токенов, баланс не сгорает`, tokenPrices[tokenPack])}>Пополнить баланс</Button><ul><li><Check/>Оплата только за фактическое использование</li><li><Check/>Предупреждения при 20% и 5% остатка</li><li><Check/>Автопополнение по желанию</li></ul></article><article className="price-card recommended"><div className="recommended-label">Самая понятная модель</div><div className="price-icon lead"><Target/></div><span className="price-eyebrow">За результат</span><h3>Подтверждённые лиды</h3><p>Платите только когда бот получил контакт и зафиксировал потребность.</p><div className="price"><b>149 ₽</b><span>за подтверждённый лид</span></div><small className="price-estimate">Спам, тесты и дубли за 30 дней не списываются</small><div className="pack-selector">{[10,30,100].map(pack => <button className={leadPack === pack ? "active" : ""} onClick={() => setLeadPack(pack)} key={pack}><b>{pack} лидов</b><small>{(pack * 149).toLocaleString("ru-RU")} ₽</small></button>)}</div><Button className="primary-action" data-live onClick={() => buy("Пакет лидов", `${leadPack} подтверждённых лидов`, leadTotal)}>Выбрать оплату за лиды</Button><ul><li><Check/>Контакт + реальный запрос клиента</li><li><Check/>7 дней на оспаривание списания</li><li><Check/>Баланс не ограничен по сроку</li></ul></article><article className="price-card unlimited"><div className="price-icon unlimited"><Sparkles/></div><span className="price-eyebrow">Дешевле рынка</span><h3>Полный безлимит</h3><p>Для активных продаж: никаких расчётов по токенам, диалогам или лидам.</p><div className="price"><b>{unlimitedMonthly.toLocaleString("ru-RU")} ₽</b><span>в месяц{annual ? " при оплате за год" : ""}</span></div><small className="price-estimate">{annual ? "118 800 ₽ одним платежом" : "Можно отменить в любой момент"}</small><Button className="unlimited-button" data-live onClick={() => buy("Полный безлимит", annual ? "12 месяцев, единым платежом" : "1 месяц", unlimitedTotal)}>Подключить безлимит <ArrowRight/></Button><ul><li><Check/>Безлимит токенов, диалогов и лидов</li><li><Check/>Безлимит посетителей и участников команды</li><li><Check/>Все функции и интеграции включены</li><li><Check/>Один бот и один основной сайт</li></ul></article></section><p className="pricing-footnote">*Расход зависит от длины диалогов, базы знаний и выбранной модели. После запуска кабинет покажет фактический расход и прогноз остатка.</p><section className="included-panel panel"><div><span className="section-label">Без скрытых ограничений</span><h2>Во всех моделях доступны все функции</h2><p>Не заставляем переходить на дорогой тариф ради аналитики, интеграций или автотестов.</p></div><div className="included-grid">{included.map(item => <span key={item}><Check/>{item}</span>)}</div></section><section className="billing-bottom"><article className="launch-card"><span className="launch-icon"><Rocket/></span><div><span className="section-label">Включено в любой тариф</span><h2>Персональное внедрение с менеджером — 0 ₽</h2><p>После заявки и открытия демо менеджер свяжется с вами, поможет настроить сценарий и знания, проверит ответы, установит виджет и подключит стандартные интеграции.</p><div><StatusPill tone="blue">Без доплаты</StatusPill><small>Один ответственный от демо до запуска</small></div></div><Button variant="outline">Открыть план внедрения</Button></article><article className="payment-settings panel"><div className="panel-head"><div><span className="section-label">Оплата</span><h2>Настройки платежей</h2></div><CreditCard/></div><div className="switch-row"><div><Wallet/><span><b>Автопополнение</b><small>При остатке меньше 20%</small></span></div><Switch checked={autoPay} onCheckedChange={setAutoPay}/></div><button data-live onClick={() => buy("Пополнение баланса", "Ручное пополнение счёта", 5000)}>Пополнить вручную <ArrowRight/></button><button data-live onClick={() => buy("Счёт для юридического лица", "Оплата по реквизитам компании", unlimitedTotal)}>Сформировать счёт <ArrowRight/></button></article></section><section className="payment-history panel"><div className="panel-head"><div><span className="section-label">Документы</span><h2>История операций</h2></div><button><Download/>Скачать акт</button></div><div className="payment-row"><span className="payment-type"><Banknote/><span><b>Демо-доступ</b><small>14 августа 2026</small></span></span><span>Все функции · 15 дней</span><b>0 ₽</b><StatusPill>Активен</StatusPill></div></section><CheckoutDialog choice={choice} onClose={() => setChoice(null)}/></div>;
}

function Team() {
  return <div className="team-page"><div className="team-summary"><div><Users /><span><b>1 сотрудник</b><small>Доступ к кабинету и CRM</small></span></div><Button className="primary-action"><Plus />Пригласить</Button></div><div className="team-table"><div className="table-head"><span>Сотрудник</span><span>Роль</span><span>Доступ</span><span>Статус</span><span /></div><div className="team-row"><div><span className="user-avatar">О</span><span><b>Олег</b><small>Владелец аккаунта</small></span></div><StatusPill tone="blue">Руководитель</StatusPill><span>Все сделки и настройки</span><StatusPill>Активен</StatusPill><button className="icon-button"><MoreHorizontal /></button></div></div><article className="panel roles-panel"><h2>Роли без лишней сложности</h2><div><span><ShieldCheck /></span><p><b>Руководитель</b><small>Видит все сделки, аналитику и настройки бота.</small></p></div><div><span><Users /></span><p><b>Сотрудник</b><small>Работает только со своими сделками в CRM.</small></p></div></article></div>;
}

function Support() {
  return <div className="support-layout"><section className="support-main panel"><div className="support-icon"><LifeBuoy /></div><h2>Чем можем помочь?</h2><p>Опишите вопрос по кабинету, боту, оплате или подключению. Ответ появится здесь и придёт на почту.</p><div className="support-categories">{["Настройка бота", "Установка", "Интеграции", "Оплата"].map(x => <button key={x}>{x}</button>)}</div><label><span>Тема</span><input placeholder="Коротко опишите вопрос" /></label><label><span>Сообщение</span><textarea placeholder="Что произошло и какой результат вы ожидаете?" /></label><Button className="primary-action">Отправить обращение <Send /></Button></section><aside className="support-side"><article className="panel"><Headphones /><h3>Нужна помощь с запуском?</h3><p>Менеджер поможет настроить знания, протестировать ответы и установить виджет.</p><button>Связаться с менеджером <ArrowRight /></button></article><article className="panel"><CircleHelp /><h3>Быстрые ответы</h3><button>Как обучать бота? <ArrowRight /></button><button>Как установить виджет? <ArrowRight /></button><button>Как приходят заявки? <ArrowRight /></button></article></aside></div>;
}

function PrototypeActionDialog({ action, onClose }: { action: string | null; onClose: () => void }) {
  const isHistory = action?.includes("история активности");
  const isBot = action?.includes("Выбор бота");
  const isProfile = action?.includes("Профиль");
  const isExport = action?.includes("Экспорт");
  const isConnection = action?.includes("интеграц") || action?.includes("Подключить");
  const title = action || "Действие";
  return <Dialog open={Boolean(action)} onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="prototype-dialog"><DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>Демонстрационное состояние интерфейса. Данные аккаунта не изменяются.</DialogDescription></DialogHeader>{isHistory ? <div className="prototype-history">{[["Новая заявка", "Анна · 12:41", Target],["База знаний обновлена", "16 записей · 12:40", Database],["Версия v7 опубликована", "Олег · вчера", History],["Telegram подключён", "26 августа", Send]].map(([name,detail,Icon]) => <div key={String(name)}><span><Icon/></span><p><b>{String(name)}</b><small>{String(detail)}</small></p><ArrowRight/></div>)}</div> : isBot ? <div className="prototype-options"><button className="active"><span className="bot-dot"><Bot/></span><p><b>Бани — ИИ-консультант</b><small>Работает · i-viking.ru</small></p><Check/></button><button><span className="bot-dot"><Bot/></span><p><b>Квадро Хаус</b><small>Черновик · не установлен</small></p><ArrowRight/></button><button><Plus/><p><b>Создать нового бота</b><small>Отдельная база знаний и аналитика</small></p><ArrowRight/></button></div> : isProfile ? <div className="prototype-form"><label><span>Имя</span><input defaultValue="Олег"/></label><label><span>Email</span><input defaultValue="oleg@example.ru"/></label><div className="switch-row"><div><Bell/><span><b>Еженедельный отчёт</b><small>По понедельникам на почту</small></span></div><Switch defaultChecked/></div></div> : isExport ? <div className="prototype-options"><button><Download/><p><b>Excel</b><small>Диалоги, статусы и контакты</small></p><ArrowRight/></button><button><Download/><p><b>CSV</b><small>Для загрузки в CRM</small></p><ArrowRight/></button><button><Download/><p><b>PDF-отчёт</b><small>Итоги выбранного периода</small></p><ArrowRight/></button></div> : isConnection ? <div className="prototype-form"><div className="prototype-steps"><span className="done"><Check/></span><p><b>Выберите сервис</b><small>Telegram, Bitrix24 или amoCRM</small></p><span>2</span><p><b>Разрешите доступ</b><small>Только к заявкам и нужным полям</small></p><span>3</span><p><b>Проверьте тестовую передачу</b><small>Покажем результат до включения</small></p></div></div> : <div className="prototype-form"><label><span>Название</span><input placeholder="Введите название"/></label><label><span>Комментарий</span><textarea placeholder="Добавьте детали, если нужно"/></label><div className="prototype-note"><ShieldCheck/><span>Перед сохранением вы увидите итог и сможете отменить действие.</span></div></div>}<DialogFooter><Button variant="outline" onClick={onClose}>Закрыть</Button>{!isHistory && !isBot && <Button className="primary-action" onClick={onClose}>{isExport ? "Скачать" : "Продолжить"}<ArrowRight/></Button>}</DialogFooter></DialogContent></Dialog>;
}

function AppContent({ view, setView, onAction, analytics, companyName, refetchAnalytics, me, period, changePeriod, crmDealToOpen, setCrmDealToOpen }: { view: View; setView: (v: View) => void; onAction: (label: string) => void; analytics: CabinetAnalytics; companyName: string; refetchAnalytics: () => void; me: CabinetMe; period: AnalyticsPeriod; changePeriod: (p: AnalyticsPeriod) => void; crmDealToOpen: string | null; setCrmDealToOpen: (id: string | null) => void }) {
  const pages: Record<View, React.ReactNode> = useMemo(() => ({
    dashboard: <Dashboard setView={setView} onAction={onAction} analytics={analytics} period={period} onPeriodChange={changePeriod} />, readiness: <Readiness setView={setView} />, attention: <Attention analytics={analytics} onProcessed={refetchAnalytics} />, dialogs: <Dialogs setView={setView} onOpenDeal={setCrmDealToOpen} />, training: <Training me={me} />, tests: <AutoTests />, knowledge: <Knowledge />, widget: <WidgetSettings />, install: <Installation />, integrations: <Integrations />, leads: <Leads setView={setView} />, crm: <CRM me={me} dealToOpen={crmDealToOpen} onDealOpened={() => setCrmDealToOpen(null)} />, billing: <Billing/>, team: <Team />, support: <Support />,
  }), [setView, onAction, analytics, refetchAnalytics, me, period, changePeriod, crmDealToOpen, setCrmDealToOpen]);
  return <><PageHeader view={view} onPrimary={onAction} companyName={companyName}/>{pages[view]}</>;
}

// First letter of up to 2 words — "Умный Чат" -> "УЧ", "Айна" -> "А". Same
// avatar-initial convention the reference itself uses ("БВ" for "Бани
// Викинг"), just computed from the real name instead of hardcoded.
function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";
}

const COMPANY_ROLE_LABELS: Record<string, string> = { owner: "Владелец", admin: "Администратор", manager: "Менеджер", employee: "Сотрудник" };

// useSidebar() only works inside SidebarProvider's own subtree — Home()
// itself renders that provider, so it can't call the hook directly. Picking
// a real page here used to leave the mobile drawer open ON TOP of it
// (found live, on a phone) — setOpenMobile(false) is the same "close after
// navigating" behavior the shadcn sidebar's own mobile menu button uses
// elsewhere, just not wired to these nav buttons before.
function NavMenuItem({ item, view, setView, badge }: { item: { id: View; label: string; icon: React.ElementType }; view: View; setView: (v: View) => void; badge?: string }) {
  const { setOpenMobile } = useSidebar();
  return <SidebarMenuItem>
    <SidebarMenuButton tooltip={item.label} isActive={view === item.id} onClick={() => { setView(item.id); setOpenMobile(false); }}>
      <item.icon /><span>{item.label}</span>
    </SidebarMenuButton>
    {badge && <SidebarMenuBadge>{badge}</SidebarMenuBadge>}
  </SidebarMenuItem>;
}

export default function Home() {
  const [view, setView] = useState<View>("dashboard");
  const [action, setAction] = useState<string | null>(null);
  // "Открыть лид" (Диалоги) -> CRM's deal panel — a cross-view handoff, so it
  // lives up here alongside view/setView rather than inside either page.
  const [crmDealToOpen, setCrmDealToOpen] = useState<string | null>(null);
  const { me, analytics, refetchAnalytics, signedOut, period, changePeriod } = useCabinetData();
  if (signedOut) {
    return <div className="dialogs-empty-conv" style={{ padding: 40 }}>Сессия не найдена, перенаправляю на вход…</div>;
  }
  const companyName = me?.companyName || "…";
  const botLabel = me?.bot?.label || me?.bot?.name || "Бот";
  const botDomain = me?.bot?.sourceWebsite || "";
  const userName = me?.userName || "…";
  const roleLabel = (me && COMPANY_ROLE_LABELS[me.companyRole]) || "Сотрудник";
  // Same definition as the old cabinet's own attentionCount (pending +
  // needsVerification escalations) — real, not the reference's static "0".
  const attentionCount = analytics ? analytics.escalations.pending.length + analytics.escalations.needsVerification.length : undefined;
  const navBadge = (item: { id: View; badge?: string }): string | undefined =>
    item.id === "attention" ? (attentionCount === undefined ? "…" : String(attentionCount)) : item.badge;
  // No more generic "demo action" popup on every unwired button (per the
  // account owner: "убери его везде, пусть сразу открывается нужная
  // страница") — buttons that already navigate somewhere (sidebar items,
  // setView calls elsewhere in this file) keep working via their own
  // handlers; anything else just does nothing now instead of a fake dialog.
  return <div className="prototype-root"><TooltipProvider><SidebarProvider><Sidebar collapsible="icon" className="app-sidebar"><SidebarHeader><Brand /><button className="company-switch" data-live onClick={() => setAction("Выбор компании")}><span>{initials(companyName)}</span><div><b>{companyName}</b><small>{botDomain}</small></div><ChevronDown /></button></SidebarHeader><SidebarContent>{nav.map(group => <SidebarGroup key={group.label}><SidebarGroupLabel>{group.label}</SidebarGroupLabel><SidebarGroupContent><SidebarMenu>{group.items.map(item => <NavMenuItem key={item.id} item={item} view={view} setView={setView} badge={navBadge(item)} />)}</SidebarMenu></SidebarGroupContent></SidebarGroup>)}</SidebarContent><SidebarFooter><div className="sidebar-help"><Zap /><span><b>Внедрение идёт</b><small>Готово 75%</small></span></div><button className="sidebar-user" data-live onClick={() => setAction("Профиль и настройки аккаунта")}><span>{initials(userName)}</span><div><b>{userName}</b><small>{roleLabel}</small></div><Settings2 /></button></SidebarFooter><SidebarRail /></Sidebar><SidebarInset className="app-inset"><Topbar onAction={setAction} botLabel={botLabel} userName={userName} userInitial={initials(userName)} roleLabel={roleLabel}/><TrialBar onBilling={() => setView("billing")}/><main className="workspace"><AppContent view={view} setView={setView} onAction={setAction} analytics={analytics} companyName={companyName} refetchAnalytics={refetchAnalytics} me={me} period={period} changePeriod={changePeriod} crmDealToOpen={crmDealToOpen} setCrmDealToOpen={setCrmDealToOpen}/></main></SidebarInset></SidebarProvider></TooltipProvider></div>;
}

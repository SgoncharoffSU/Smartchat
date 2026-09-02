"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity, AlertCircle, ArrowRight, Bell, BookOpen, Bot, Check,
  Banknote, BrainCircuit, Building2, ChevronDown, CircleHelp, ClipboardCheck, Clock3, Copy, CreditCard, Database, Download, ExternalLink,
  FileUp, Flame, Globe2, GraduationCap, Headphones, History, Inbox, Info, LayoutDashboard, LifeBuoy, Link2, ListFilter,
  MessageSquareText, MoreHorizontal, MousePointerClick, Plus, Rocket, Search, Send, Settings2,
  ShieldCheck, SlidersHorizontal, Sparkles, Target, TestTube2, Users, WandSparkles,
  Wallet, Workflow, X, Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger,
} from "@/components/ui/sheet";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent,
  SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuBadge,
  SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarRail, SidebarTrigger,
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
  bot: { id: string; name: string; label: string; sourceWebsite: string | null } | null;
  userName: string;
  companyRole: string;
} | null;

type CabinetAnalytics = {
  shown: { count: number; deltaPct: number | null };
  opened: { count: number; conversionRate: number; openedToDialogRate: number; deltaPct: number | null };
  dialogs: { count: number; conversionRate: number; deltaPct: number | null };
  leads: { count: number; conversionRate: number; deltaPct: number | null };
  problems: { count: number; resolved: number };
  escalations: { pending: unknown[]; needsVerification: unknown[] };
} | null;

function useCabinetData() {
  const [me, setMe] = useState<CabinetMe>(null);
  const [analytics, setAnalytics] = useState<CabinetAnalytics>(null);
  useEffect(() => {
    fetch("/api/cabinet/me")
      .then((r) => (r.ok ? r.json() : null))
      .then(setMe)
      .catch(() => setMe(null));
    fetch("/api/cabinet/analytics?period=week")
      .then((r) => (r.ok ? r.json() : null))
      .then(setAnalytics)
      .catch(() => setAnalytics(null));
  }, []);
  return { me, analytics };
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
  const actions: Partial<Record<View, string>> = { knowledge: "Добавить знания", dialogs: "Экспорт", integrations: "Добавить интеграцию", crm: "Новая сделка", team: "Пригласить", support: "Новое обращение" };
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

function Dashboard({ setView, onAction, analytics }: { setView: (v: View) => void; onAction: (label: string) => void; analytics: CabinetAnalytics }) {
  const shown = analytics?.shown.count;
  const opened = analytics?.opened.count;
  const dialogs = analytics?.dialogs.count;
  const leads = analytics?.leads.count;
  // Bar widths in the funnel below are relative to the first (largest)
  // stage — same visual idea as the reference's own hardcoded 100/82/65/46,
  // just computed from real counts instead.
  const pct = (n: number | undefined) => (shown && n !== undefined && shown > 0 ? Math.max(4, Math.round((n / shown) * 100)) : 0);
  return <>
    <div className="dashboard-toolbar"><Tabs defaultValue="week"><TabsList><TabsTrigger value="day">Вчера</TabsTrigger><TabsTrigger value="week">Неделя</TabsTrigger><TabsTrigger value="month">Месяц</TabsTrigger><TabsTrigger value="all">Всё время</TabsTrigger></TabsList></Tabs><button className="date-filter"><ListFilter /> Последние 7 дней</button></div>
    <section className="metrics-grid"><Metric label="Посетители" value={fmtNum(shown)} note="На страницах с виджетом" tone="violet" icon={Activity} /><Metric label="Открыли чат" value={fmtNum(opened)} note={`${fmtPct(analytics?.opened.conversionRate)} посетителей`} tone="cyan" icon={MousePointerClick} /><Metric label="Диалоги" value={fmtNum(dialogs)} note={`${fmtPct(analytics?.dialogs.conversionRate)} посетителей начали разговор`} tone="green" icon={MessageSquareText} /><Metric label="Заявки" value={fmtNum(leads)} note={`${fmtPct(analytics?.leads.conversionRate)} диалогов оставили контакт`} tone="lime" icon={Target} /></section>
    <section className="dashboard-grid">
      <article className="panel funnel-panel"><div className="panel-head"><div><span className="section-label">Воронка</span><h2>Путь посетителя к заявке</h2></div><button className="ghost-action" data-live onClick={() => onAction("Как считается воронка")}>Как считается <ArrowRight /></button></div><div className="funnel"><div className="funnel-stage"><span>Посетитель</span><b>{fmtNum(shown)}</b><i style={{ width: `${pct(shown)}%` }} /></div><div className="funnel-arrow"><span>{fmtPct(analytics?.opened.conversionRate)}</span><ArrowRight /></div><div className="funnel-stage"><span>Открыл чат</span><b>{fmtNum(opened)}</b><i style={{ width: `${pct(opened)}%` }} /></div><div className="funnel-arrow"><span>{fmtPct(analytics?.opened.openedToDialogRate)}</span><ArrowRight /></div><div className="funnel-stage"><span>Диалог</span><b>{fmtNum(dialogs)}</b><i style={{ width: `${pct(dialogs)}%` }} /></div><div className="funnel-arrow"><span>{fmtPct(analytics?.leads.conversionRate)}</span><ArrowRight /></div><div className="funnel-stage"><span>Заявка</span><b>{fmtNum(leads)}</b><i style={{ width: `${pct(leads)}%` }} /></div></div><div className="insight"><Info /><div><b>Показатели собираются автоматически</b><span>Виджет фиксирует посещения, открытия чата, начатые диалоги и полученные контакты.</span></div><button data-live onClick={() => onAction("События аналитики")}>Подробнее</button></div></article>
      <ConversionChart/>
      <article className="panel readiness-card"><div className="readiness-ring"><svg viewBox="0 0 88 88"><circle cx="44" cy="44" r="37" /><circle className="ready manager-progress" cx="44" cy="44" r="37" /></svg><strong>75%</strong></div><div><span className="section-label">Внедрение с менеджером</span><h2>Подготовка к запуску</h2><p>Менеджер настраивает сценарий, знания и подключения. Здесь виден общий статус.</p><button className="inline-action" data-live onClick={() => setView("readiness")}>Открыть план <ArrowRight /></button></div></article>
      <article className="panel quality-panel"><div className="panel-head"><div><span className="section-label">Качество</span><h2>Ответы под контролем</h2></div><StatusPill>Всё хорошо</StatusPill></div><div className="quality-stats"><div><b>0</b><span>требуют внимания</span></div><div><b>34</b><span>проверено</span></div><div><b>8</b><span>улучшено</span></div></div><button className="wide-ghost" data-live onClick={() => setView("attention")}>Открыть центр качества</button></article>
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

function Attention() {
  return <div className="attention-layout"><article className="panel empty-quality"><div className="empty-orbit"><ShieldCheck /></div><h2>Сейчас всё под контролем</h2><p>Нет ответов, которые требуют проверки. Когда бот столкнётся со сложным вопросом или получит негативную оценку, он появится здесь.</p><div className="empty-actions"><Button variant="outline">Найти повторяющиеся вопросы</Button><Button className="primary-action">Проверить тестовый диалог</Button></div></article><aside className="panel how-panel"><span className="section-label">Как это работает</span><h3>Единый центр качества</h3><ul><li><span>1</span>Бот отмечает слабый ответ</li><li><span>2</span>Вы добавляете правильную информацию</li><li><span>3</span>Ответ сразу попадает в базу знаний</li></ul></aside></div>;
}

function Dialogs() {
  return <div className="dialogs-shell"><aside className="dialog-list"><div className="dialog-tools"><div className="search-field"><Search /><input placeholder="Поиск по диалогам" /></div><button aria-label="Фильтры"><ListFilter /></button></div><div className="filter-chips"><button className="active">Все</button><button>С заявкой</button><button>Нужен человек</button></div><div className="channel-filter"><button className="active"><Globe2 />Сайт</button><button>Telegram</button><button>WhatsApp</button></div>{["Анна · подбор бани", "Михаил · стоимость", "Новый посетитель"].map((name, i) => <button className={`dialog-row ${i === 0 ? "active" : ""}`} key={name}><span className="dialog-avatar">{i ? "М" : "А"}</span><span><b>{name}</b><small>{i === 0 ? "Нужна баня для семьи из четырёх…" : "Хочу узнать срок изготовления…"}</small></span><time>{i === 0 ? "12:41" : "вчера"}</time></button>)}</aside><section className="conversation"><div className="conversation-head"><div><b>Анна · подбор бани</b><span><i /> Диалог завершён · 4 мин · Сайт</span></div><div><Button variant="outline" className="take-dialog"><Headphones />Взять диалог</Button><StatusPill>Заявка получена</StatusPill><button className="icon-button"><MoreHorizontal /></button></div></div><div className="conversation-context"><span><Globe2 /></span><p><b>Источник: Яндекс Реклама</b><small>Страница «Бани 6 метров» · utm_campaign=summer</small></p><button>Открыть страницу <ExternalLink /></button></div><div className="messages"><div className="message bot-message"><span className="mini-bot"><Bot /></span><p>Здравствуйте! Помогу подобрать баню. Сколько человек будет пользоваться ею обычно?</p><small>12:38</small></div><div className="message client-message"><p>Для семьи из четырёх человек. Хотим пользоваться круглый год.</p><small>12:39</small></div><div className="message bot-message"><span className="mini-bot"><Bot /></span><p>Тогда подойдут модели 6 или 8 метров. Подскажите, участок уже подготовлен и в каком регионе планируется установка?</p><small>12:39</small></div><div className="goal-message"><Target /><span><b>Цель достигнута</b><small>Посетитель оставил номер телефона</small></span></div></div><div className="conversation-foot"><div><ClipboardCheck /><span><b>AI-резюме</b><small>Семья из 4 человек, круглогодичное использование, выбирает между 6 и 8 м. Следующий шаг: позвонить и уточнить регион.</small></span></div><Button variant="outline">Открыть лид <ArrowRight /></Button></div></section></div>;
}

function Training() {
  return <div className="training-layout"><section className="training-guide"><span className="section-label">Тестовая среда</span><h2>Поговорите с ботом как клиент</h2><p>Это точная копия виджета на сайте. Тестовые сообщения не влияют на аналитику.</p><div className="tip-card"><WandSparkles /><div><b>Как обучать быстрее</b><span>Если ответ не подходит, нажмите «Улучшить ответ» и добавьте правильную информацию. Бот запомнит её сразу.</span></div></div><div className="share-test"><Users /><div><b>Дать доступ коллеге</b><span>Без входа в личный кабинет</span></div><Button variant="outline">Скопировать ссылку</Button></div></section><section className="widget-preview"><div className="widget-head"><span className="bot-avatar">А</span><div><b>Алексей</b><small><i /> На связи прямо сейчас</small></div><button><X /></button></div><div className="widget-messages"><p className="widget-bot">Добрый день! Помогу подобрать решение. Что для вас сейчас важнее всего?</p><p className="widget-user">Хочу понять стоимость и сроки</p><p className="widget-bot">Подскажите, какой вариант рассматриваете и где планируется установка?</p><button className="improve"><WandSparkles /> Улучшить ответ</button></div><div className="widget-input"><input placeholder="Напишите сообщение" /><button><Send /></button></div></section></div>;
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

const knowledgeItems = [
  ["Какие размеры доступны для бань «Викинг»?", "Доступны модели длиной 4, 6 и 8 метров.", "Вопрос / ответ", "Сайт"],
  ["Как быстро прогревается парилка?", "Мощная печь прогревает парилку до рабочей температуры примерно за час.", "Вопрос / ответ", "Сайт"],
  ["Обращайся к посетителю только на «вы»", "Правило применяется ко всем новым диалогам.", "Инструкция", "Вручную"],
  ["Какая гарантия предоставляется?", "На сканди-баню предоставляется гарантия 5 лет.", "Вопрос / ответ", "Сайт"],
];

function AddKnowledgeSheet({ children }: { children: React.ReactNode }) {
  return <Sheet><SheetTrigger asChild>{children}</SheetTrigger><SheetContent className="knowledge-sheet"><SheetHeader><SheetTitle>Добавить знания</SheetTitle><SheetDescription>Выберите удобный источник. Перед публикацией записи можно проверить.</SheetDescription></SheetHeader><div className="source-options"><button><Link2 /><span><b>Добавить сайт</b><small>Импортировать страницы по ссылке</small></span><ArrowRight /></button><button><FileUp /><span><b>Загрузить файл</b><small>PDF, DOCX, XLSX, TXT или CSV</small></span><ArrowRight /></button><button><Database /><span><b>Вставить текст</b><small>Инструкция, статья или ответы</small></span><ArrowRight /></button><button><BookOpen /><span><b>Вопрос и ответ</b><small>Добавить одну точную запись</small></span><ArrowRight /></button></div></SheetContent></Sheet>;
}

function Knowledge() {
  const [query, setQuery] = useState(""); const filtered = knowledgeItems.filter(i => i[0].toLowerCase().includes(query.toLowerCase()));
  return <div className="knowledge-page"><div className="knowledge-summary"><div><Database /><span><b>17 записей</b><small>Все записи проверены и используются ботом</small></span></div><div className="summary-segment"><span style={{ width: "94%" }} /><small>16 вопросов и ответов</small></div><AddKnowledgeSheet><Button className="primary-action"><Plus />Добавить знания</Button></AddKnowledgeSheet></div><div className="knowledge-toolbar"><div className="search-field"><Search /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Найти по смыслу или словам" /></div><div className="filter-chips"><button className="active">Все 17</button><button>Вопросы 16</button><button>Инструкции 1</button></div><button className="filter-button"><ListFilter /> Фильтры</button></div><div className="knowledge-table"><div className="table-head"><span>Запись</span><span>Тип</span><span>Источник</span><span>Статус</span><span /></div>{filtered.map(item => <div className="knowledge-row" key={item[0]}><div><b>{item[0]}</b><small>{item[1]}</small></div><StatusPill tone="blue">{item[2]}</StatusPill><span className="source-cell">{item[3]}</span><StatusPill><Check /> Живая</StatusPill><button className="icon-button"><MoreHorizontal /></button></div>)}</div></div>;
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

const columns = [
  { name: "Новая", count: 2, items: [["Анна", "Подбор бани · 6 или 8 м", "Сегодня, 12:41"], ["Михаил", "Запрос стоимости", "Сегодня, 10:16"]] },
  { name: "В работе", count: 1, items: [["Сергей", "Установка в Московской области", "Вчера"]] },
  { name: "Успешно", count: 1, items: [["Елена", "Баня 6 м · договор", "25 августа"]] },
  { name: "Отказ", count: 0, items: [] },
];

function CRM() {
  return <div className="crm-page"><div className="crm-toolbar"><div className="search-field"><Search /><input placeholder="Поиск по сделкам" /></div><button className="filter-button"><ListFilter /> Фильтры</button><Button className="primary-action"><Plus />Новая сделка</Button></div><div className="kanban">{columns.map((col, ci) => <section className="kanban-col" key={col.name}><div className="kanban-head"><span><i className={`col-dot c${ci}`} />{col.name}</span><b>{col.count}</b><button><MoreHorizontal /></button></div><div className="kanban-stack">{col.items.map(item => <article className="deal-card" key={item[0]}><div><span className="deal-avatar">{item[0][0]}</span><StatusPill tone={ci === 2 ? "green" : ci === 3 ? "gray" : "blue"}>{ci === 0 ? "Новая" : col.name}</StatusPill></div><h3>{item[0]}</h3><p>{item[1]}</p><small>{item[2]}</small><div className="deal-foot"><span><MessageSquareText /> Диалог</span><button><ArrowRight /></button></div></article>)}{col.items.length === 0 && <div className="drop-empty">Перетащите сделку сюда</div>}<button className="add-deal"><Plus /> Добавить</button></div></section>)}</div></div>;
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

function AppContent({ view, setView, onAction, analytics, companyName }: { view: View; setView: (v: View) => void; onAction: (label: string) => void; analytics: CabinetAnalytics; companyName: string }) {
  const pages: Record<View, React.ReactNode> = useMemo(() => ({
    dashboard: <Dashboard setView={setView} onAction={onAction} analytics={analytics} />, readiness: <Readiness setView={setView} />, attention: <Attention />, dialogs: <Dialogs />, training: <Training />, tests: <AutoTests />, knowledge: <Knowledge />, widget: <WidgetSettings />, install: <Installation />, integrations: <Integrations />, leads: <Leads setView={setView} />, crm: <CRM />, billing: <Billing/>, team: <Team />, support: <Support />,
  }), [setView, onAction, analytics]);
  return <><PageHeader view={view} onPrimary={onAction} companyName={companyName}/>{pages[view]}</>;
}

// First letter of up to 2 words — "Умный Чат" -> "УЧ", "Айна" -> "А". Same
// avatar-initial convention the reference itself uses ("БВ" for "Бани
// Викинг"), just computed from the real name instead of hardcoded.
function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";
}

const COMPANY_ROLE_LABELS: Record<string, string> = { owner: "Владелец", admin: "Администратор", manager: "Менеджер", employee: "Сотрудник" };

export default function Home() {
  const [view, setView] = useState<View>("dashboard");
  const [action, setAction] = useState<string | null>(null);
  const { me, analytics } = useCabinetData();
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
  return <div className="prototype-root"><TooltipProvider><SidebarProvider><Sidebar collapsible="icon" className="app-sidebar"><SidebarHeader><Brand /><button className="company-switch" data-live onClick={() => setAction("Выбор компании")}><span>{initials(companyName)}</span><div><b>{companyName}</b><small>{botDomain}</small></div><ChevronDown /></button></SidebarHeader><SidebarContent>{nav.map(group => <SidebarGroup key={group.label}><SidebarGroupLabel>{group.label}</SidebarGroupLabel><SidebarGroupContent><SidebarMenu>{group.items.map(item => <SidebarMenuItem key={item.id}><SidebarMenuButton tooltip={item.label} isActive={view === item.id} onClick={() => setView(item.id)}><item.icon /><span>{item.label}</span></SidebarMenuButton>{navBadge(item) && <SidebarMenuBadge>{navBadge(item)}</SidebarMenuBadge>}</SidebarMenuItem>)}</SidebarMenu></SidebarGroupContent></SidebarGroup>)}</SidebarContent><SidebarFooter><div className="sidebar-help"><Zap /><span><b>Внедрение идёт</b><small>Готово 75%</small></span></div><button className="sidebar-user" data-live onClick={() => setAction("Профиль и настройки аккаунта")}><span>{initials(userName)}</span><div><b>{userName}</b><small>{roleLabel}</small></div><Settings2 /></button></SidebarFooter><SidebarRail /></Sidebar><SidebarInset className="app-inset"><Topbar onAction={setAction} botLabel={botLabel} userName={userName} userInitial={initials(userName)} roleLabel={roleLabel}/><TrialBar onBilling={() => setView("billing")}/><main className="workspace"><AppContent view={view} setView={setView} onAction={setAction} analytics={analytics} companyName={companyName}/></main></SidebarInset></SidebarProvider></TooltipProvider></div>;
}

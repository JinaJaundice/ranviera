// The windows the dock can open. Each module must exist at the path given and export the named component.
import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import { Activity, BookA, Bot, DatabaseZap, FolderKanban, Info, Network, ScrollText, Settings, ShieldCheck, type LucideIcon } from "lucide-react";

export interface AppProps {
  params?: Record<string, string>;
}

export interface AppDef {
  id: string;
  title: string;
  icon: LucideIcon;
  /** default window size in px */
  size: { w: number; h: number };
  component: LazyExoticComponent<ComponentType<AppProps>>;
  /** keyboard shortcut digit, opened with Alt and the digit */
  key: string;
}

export const APPS: AppDef[] = [
  {
    id: "missions",
    title: "Missions",
    icon: Bot,
    size: { w: 980, h: 680 },
    key: "1",
    component: lazy(() => import("./missions/MissionsApp").then((m) => ({ default: m.MissionsApp }))),
  },
  {
    id: "graph",
    title: "Graph",
    icon: Network,
    size: { w: 1100, h: 720 },
    key: "2",
    component: lazy(() => import("./graph/GraphApp").then((m) => ({ default: m.GraphApp }))),
  },
  {
    id: "rules",
    title: "Rules",
    icon: ScrollText,
    size: { w: 980, h: 680 },
    key: "3",
    component: lazy(() => import("./rules/RulesApp").then((m) => ({ default: m.RulesApp }))),
  },
  {
    id: "lexicon",
    title: "Lexicon",
    icon: BookA,
    size: { w: 920, h: 640 },
    key: "4",
    component: lazy(() => import("./lexicon/LexiconApp").then((m) => ({ default: m.LexiconApp }))),
  },
  {
    id: "projects",
    title: "Projects",
    icon: FolderKanban,
    size: { w: 980, h: 660 },
    key: "5",
    component: lazy(() => import("./projects/ProjectsApp").then((m) => ({ default: m.ProjectsApp }))),
  },
  {
    id: "pulse",
    title: "Pulse",
    icon: Activity,
    size: { w: 900, h: 640 },
    key: "6",
    component: lazy(() => import("./pulse/PulseApp").then((m) => ({ default: m.PulseApp }))),
  },
  {
    id: "query",
    title: "Query",
    icon: DatabaseZap,
    size: { w: 1040, h: 700 },
    key: "8",
    component: lazy(() => import("./query/QueryApp").then((m) => ({ default: m.QueryApp }))),
  },
  {
    id: "health",
    title: "Health",
    icon: ShieldCheck,
    size: { w: 900, h: 640 },
    key: "7",
    component: lazy(() => import("./health/HealthApp").then((m) => ({ default: m.HealthApp }))),
  },
  {
    id: "settings",
    title: "Settings",
    icon: Settings,
    size: { w: 760, h: 680 },
    key: "9",
    component: lazy(() => import("./settings/SettingsApp").then((m) => ({ default: m.SettingsApp }))),
  },
  {
    id: "about",
    title: "About",
    icon: Info,
    size: { w: 640, h: 640 },
    key: "0",
    component: lazy(() => import("./about/AboutApp").then((m) => ({ default: m.AboutApp }))),
  },
];

export const APP_BY_ID = new Map(APPS.map((a) => [a.id, a]));

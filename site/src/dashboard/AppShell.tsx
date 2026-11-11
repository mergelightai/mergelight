import { useEffect, useState, type ReactNode } from 'react';
import { RotateCwIcon, ExternalLinkIcon, EllipsisIcon, PuzzleIcon, BrainIcon, LifeBuoyIcon, SendIcon, ChevronDownIcon, ChevronsUpDownIcon, CheckIcon, GitPullRequestIcon, ListChecksIcon, ScrollTextIcon, LogOutIcon } from '@/lib/icons';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger, useSidebar } from '@/components/ui/sidebar';
import { ADD_REPOS_URL, signInUrl, type Org, type Session } from './api';
import { ago } from './format';
import { EMAIL, GITHUB } from '../links';

export type ViewId = 'reviews' | 'rules' | 'skills' | 'checks' | 'decisions';

/** The views, in the order of the menu. New views (the team view, settings) go into these groups later. */
export const VIEWS: { group: string; items: { id: ViewId; label: string; icon: typeof GitPullRequestIcon }[] }[] = [
  { group: 'Overview', items: [{ id: 'reviews', label: 'Reviews', icon: GitPullRequestIcon }] },
  {
    group: 'Reviewer',
    items: [
      { id: 'rules', label: 'Rules', icon: ScrollTextIcon },
      { id: 'skills', label: 'Skills', icon: PuzzleIcon },
      { id: 'checks', label: 'Checks', icon: ListChecksIcon },
      { id: 'decisions', label: 'Decisions', icon: BrainIcon },
    ],
  },
];

/** The org's picture from GitHub, or its first letter while that loads or if it fails. */
function OrgIcon({ org }: { org: Org }) {
  return (
    <Avatar className="size-6 rounded-[7px]! after:rounded-[7px]!">
      <AvatarImage src={`https://github.com/${encodeURIComponent(org.login)}.png?size=48`} alt="" className="rounded-[7px]!" />
      <AvatarFallback className="rounded-[7px]! bg-primary text-xs font-semibold uppercase text-primary-foreground">{org.login.slice(0, 1)}</AvatarFallback>
    </Avatar>
  );
}

/** A menu item. The one you are on is a raised tile with a small lit bar on its left and a lit icon. */
const NAV_ITEM = [
  'relative text-sidebar-foreground/65 hover:bg-white/[0.04] hover:text-sidebar-foreground',
  'data-active:bg-white/[0.06] data-active:font-medium data-active:text-sidebar-foreground',
  'data-active:shadow-[inset_0_1px_0_rgb(255_255_255/0.06),0_0_0_1px_rgb(255_255_255/0.05)]',
  // The light that is on: a small mint dot with a glow, as on the landing page and on a passing review.
  'data-active:after:absolute data-active:after:right-3 data-active:after:top-1/2 data-active:after:size-1.5 data-active:after:-translate-y-1/2 data-active:after:rounded-full data-active:after:bg-mint data-active:after:shadow-[0_0_10px_2px_rgb(63_232_184/0.55)]',
  'group-data-[collapsible=icon]:after:hidden',
].join(' ');

/** A view in the menu. On a phone the menu is a sheet over the page, so picking a view closes it. */
function NavButton({ active, label, icon: Icon, onClick }: { active: boolean; label: string; icon: (props: { className?: string }) => React.JSX.Element; onClick: () => void }) {
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <SidebarMenuButton
      isActive={active}
      onClick={() => {
        onClick();
        if (isMobile) setOpenMobile(false);
      }}
      className={NAV_ITEM}
      tooltip={label}
    >
      <Icon />
      <span>{label}</span>
    </SidebarMenuButton>
  );
}

function OrgPicker({ orgs, org, onPick }: { orgs: Org[]; org: Org; onPick: (id: number) => void }) {
  if (orgs.length < 2) {
    return (
      <div className="flex h-8 items-center gap-2 px-1.5">
        <OrgIcon org={org} />
        <span className="truncate font-medium">{org.login}</span>
      </div>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<SidebarMenuButton className="w-fit px-1.5 group-data-[collapsible=icon]:p-1!" aria-label="Switch org" />}>
        <OrgIcon org={org} />
        <span className="truncate font-medium">{org.login}</span>
        <ChevronDownIcon className="size-3.5 opacity-50" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Orgs</DropdownMenuLabel>
          {orgs.map((o) => (
            <DropdownMenuItem key={o.id} onClick={() => onPick(o.id)}>
              <OrgIcon org={o} />
              <span className="flex-1 truncate">{o.login}</span>
              {o.id === org.id && <CheckIcon className="size-4" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The person who is signed in. Their picture comes from GitHub, by their GitHub user id. */
function Who({ user }: { user: Session['user'] }) {
  return (
    <>
      <Avatar className="size-8 rounded-[10px]! after:rounded-[10px]!">
        <AvatarImage src={`https://avatars.githubusercontent.com/u/${user.id}?s=80`} alt="" className="rounded-[10px]!" />
        <AvatarFallback className="rounded-[10px]! uppercase">{user.login.slice(0, 1)}</AvatarFallback>
      </Avatar>
      <span className="grid flex-1 text-left leading-tight">
        <span className="truncate font-medium">{user.login}</span>
        <span className="truncate text-xs text-muted-foreground">Signed in with GitHub</span>
      </span>
    </>
  );
}

function NavUser({ user, onSignOut }: { user: Session['user']; onSignOut: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<SidebarMenuButton size="lg" aria-label="Your account" />}>
        <Who user={user} />
        <ChevronsUpDownIcon className="ml-auto size-4 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex items-center gap-2 py-1.5 font-normal text-foreground">
            <Who user={user} />
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onSignOut}>
          <LogOutIcon />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** "Updated 2 minutes ago". It counts on by itself, so an old page says it is old. */
function Updated({ at }: { at: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return <span className="hidden text-sm text-muted-foreground sm:inline">Updated {ago(new Date(at).toISOString())}</span>;
}

/** The page's own actions, out of the way until someone needs them. */
function PageMenu({ orgLogin, onRefresh }: { orgLogin: string; onRefresh: () => void }) {
  const link = 'h-8 gap-1.5 rounded-full px-2.5 text-[13px] text-muted-foreground data-highlighted:text-foreground';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="More" />}>
        <EllipsisIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-[23rem] whitespace-nowrap"
        footer={
          <>
            <span className="mr-auto pl-1 text-[13px] text-muted-foreground">Missing an org?</span>
            <DropdownMenuItem className={link} render={<a href={ADD_REPOS_URL} target="_blank" rel="noreferrer" />}>
              Add it on GitHub
              <ExternalLinkIcon className="size-3.5" />
            </DropdownMenuItem>
            <DropdownMenuItem className={link} render={<a href={signInUrl()} />}>
              Sign in again
            </DropdownMenuItem>
          </>
        }
      >
        <DropdownMenuItem onClick={onRefresh}>
          <RotateCwIcon />
          Refresh {orgLogin}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppShell({ user, orgs, org, onPickOrg, view, onView, onSignOut, loadedAt, onRefresh, children }: { user: Session['user']; orgs: Org[]; org: Org; onPickOrg: (id: number) => void; view: ViewId; onView: (v: ViewId) => void; onSignOut: () => void; loadedAt: number | null; onRefresh: () => void; children: ReactNode }) {
  const group = VIEWS.find((g) => g.items.some((i) => i.id === view)) ?? VIEWS[0];
  const here = { label: group.items.find((i) => i.id === view)?.label ?? '' };
  return (
    <TooltipProvider>
    <SidebarProvider defaultOpen={!document.cookie.split('; ').includes('sidebar_state=false')}>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <OrgPicker orgs={orgs} org={org} onPick={onPickOrg} />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          {VIEWS.map((g) => (
            <SidebarGroup key={g.group}>
              {g.group !== 'Overview' && <SidebarGroupLabel className="h-7 text-[11px] font-medium uppercase tracking-[0.08em] text-sidebar-foreground/40">{g.group}</SidebarGroupLabel>}
              <SidebarGroupContent>
                <SidebarMenu>
                  {g.items.map((item) => (
                    <SidebarMenuItem key={item.id}>
                      <NavButton active={view === item.id} label={item.label} icon={item.icon} onClick={() => onView(item.id)} />
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="sm" tooltip="Support" render={<a href={`mailto:${EMAIL}?subject=Mergelight%20support`} />}>
                <LifeBuoyIcon />
                <span>Support</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton size="sm" tooltip="Feedback" render={<a href={`${GITHUB}/issues/new`} target="_blank" rel="noreferrer" />}>
                <SendIcon />
                <span>Feedback</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          <SidebarMenu className="mt-2">
            <SidebarMenuItem>
              <NavUser user={user} onSignOut={onSignOut} />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="relative isolate overflow-hidden">
        <div aria-hidden="true" className="page-light -z-10" />
        <header className="flex h-16 shrink-0 items-center gap-2 px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 data-vertical:h-4 data-vertical:self-center" />
          <h1 className="truncate text-sm font-medium">{here.label}</h1>
          <div className="ml-auto flex items-center gap-2">
            {loadedAt && <Updated at={loadedAt} />}
            <PageMenu orgLogin={org.login} onRefresh={onRefresh} />
          </div>
        </header>
        <div className="flex w-full flex-1 flex-col px-4 pb-6 pt-2">{children}</div>
      </SidebarInset>
      {/* Outside the page region, so a message shows above an open form window. Sonner announces it to screen readers. */}
      <Toaster position="bottom-right" />
    </SidebarProvider>
    </TooltipProvider>
  );
}

export function ViewHeader({ eyebrow, title, lead, action }: { eyebrow?: string; title: string; lead?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-x-6 gap-y-4 pt-2">
      <div className="max-w-2xl">
        {eyebrow && <p className="text-sm font-medium text-mint">{eyebrow}</p>}
        <h1 className="mt-1.5 font-heading text-[32px] font-semibold leading-[1.1] tracking-[-0.035em] [text-wrap:balance]">{title}</h1>
        {lead && <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground [text-wrap:pretty]">{lead}</p>}
      </div>
      {action}
    </div>
  );
}

import { useEffect, useState, type ReactNode } from 'react';
import { RotateCwIcon, ExternalLinkIcon, EllipsisIcon, PuzzleIcon, BrainIcon, LifeBuoyIcon, SendIcon, ChevronDownIcon, ChevronsUpDownIcon, CheckIcon, GitPullRequestIcon, ListChecksIcon, ScrollTextIcon, LogOutIcon } from '@/lib/icons';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger, useSidebar } from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';
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
function OrgIcon({ org, className = 'size-6' }: { org: Org; className?: string }) {
  return (
    <Avatar className={cn('rounded-[7px]! after:rounded-[7px]!', className)}>
      <AvatarImage src={`https://github.com/${encodeURIComponent(org.login)}.png?size=48`} alt="" className="rounded-[7px]!" />
      <AvatarFallback className="rounded-[7px]! bg-action text-xs font-semibold uppercase text-action-ink">{org.login.slice(0, 1)}</AvatarFallback>
    </Avatar>
  );
}

/**
 * A view in the menu, as in the reference: quiet grey text with a grey icon, and the view you are on
 * set into a dark tile with a hairline edge, the same dark as the content panel.
 */
const NAV_ITEM = [
  'h-9 gap-2.5 rounded-[10px]! px-2.5 text-[14.5px] text-ink-2 [&_svg]:text-[#82827f] hover:bg-white/[0.04] hover:text-ink',
  'data-active:bg-panel data-active:font-normal data-active:text-ink data-active:[&_svg]:text-ink data-active:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.055)]',
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
      <Icon className="size-[18px]" />
      <span>{label}</span>
    </SidebarMenuButton>
  );
}

/** A group of views under a small title with a caret, which folds the group away. */
function NavGroup({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <SidebarGroup className="py-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="mb-1 flex h-7 w-fit items-center gap-1 rounded-md px-2.5 text-[13px] text-[#71716f] transition-colors hover:text-ink-3 group-data-[collapsible=icon]:hidden"
      >
        {title}
        <ChevronDownIcon className={cn('size-3 transition-transform duration-150', !open && '-rotate-90')} />
      </button>
      {open && <SidebarGroupContent>{children}</SidebarGroupContent>}
    </SidebarGroup>
  );
}

function OrgPicker({ orgs, org, onPick }: { orgs: Org[]; org: Org; onPick: (id: number) => void }) {
  if (orgs.length < 2) {
    return (
      <div className="flex h-9 items-center gap-2.5 px-1.5">
        <OrgIcon org={org} />
        <span className="truncate text-[15px] font-semibold tracking-[-0.01em] text-ink group-data-[collapsible=icon]:hidden">{org.login}</span>
      </div>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<SidebarMenuButton className="h-9 w-fit gap-2.5 rounded-[10px]! px-1.5 group-data-[collapsible=icon]:p-1!" aria-label="Switch org" />}>
        <OrgIcon org={org} />
        <span className="truncate text-[15px] font-semibold tracking-[-0.01em] text-ink">{org.login}</span>
        <ChevronDownIcon className="size-3.5 text-ink-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Orgs</DropdownMenuLabel>
          {orgs.map((o) => (
            <DropdownMenuItem key={o.id} onClick={() => onPick(o.id)}>
              <OrgIcon org={o} className="size-5" />
              <span className="flex-1 truncate">{o.login}</span>
              {o.id === org.id && <CheckIcon className="size-4 text-ink" />}
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
      <Avatar className="size-8">
        <AvatarImage src={`https://avatars.githubusercontent.com/u/${user.id}?s=80`} alt="" />
        <AvatarFallback className="bg-strip text-xs uppercase text-ink-3">{user.login.slice(0, 2)}</AvatarFallback>
      </Avatar>
      <span className="grid flex-1 text-left leading-tight">
        <span className="truncate text-[14px] font-medium text-ink">{user.login}</span>
        <span className="truncate text-xs text-ink-4">Signed in with GitHub</span>
      </span>
    </>
  );
}

function NavUser({ user, onSignOut }: { user: Session['user']; onSignOut: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<SidebarMenuButton size="lg" className="h-12 rounded-[10px]! px-2 hover:bg-white/[0.04]" aria-label="Your account" />}>
        <Who user={user} />
        <ChevronsUpDownIcon className="ml-auto size-4 text-ink-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex items-center gap-2 py-1.5 font-normal">
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
  return <span className="hidden text-[13px] text-ink-4 sm:inline">Updated {ago(new Date(at).toISOString())}</span>;
}

/** The page's own actions, out of the way until someone needs them. */
function PageMenu({ orgLogin, onRefresh }: { orgLogin: string; onRefresh: () => void }) {
  const link = 'h-7 gap-1.5 rounded-[7px] px-2 text-[13px] text-ink-3 data-highlighted:text-ink';
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
            <span className="mr-auto pl-1 text-[13px] text-ink-4">Missing an org?</span>
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

/** The menu button in the content panel: on a phone, and when the menu is shrunk to icons. */
function PanelTrigger() {
  const { isMobile, state } = useSidebar();
  if (!isMobile && state === 'expanded') return null;
  return <SidebarTrigger className="-ml-1.5 size-8 rounded-[8px] text-ink-3 hover:bg-white/[0.05] hover:text-ink" />;
}

export function AppShell({ user, orgs, org, onPickOrg, view, onView, onSignOut, loadedAt, onRefresh, children }: { user: Session['user']; orgs: Org[]; org: Org; onPickOrg: (id: number) => void; view: ViewId; onView: (v: ViewId) => void; onSignOut: () => void; loadedAt: number | null; onRefresh: () => void; children: ReactNode }) {
  const group = VIEWS.find((g) => g.items.some((i) => i.id === view)) ?? VIEWS[0];
  const here = { label: group.items.find((i) => i.id === view)?.label ?? '' };
  return (
    <TooltipProvider>
      {/* On a wide screen the app is a window on a wall: a glass rim around a dark shell, as in the reference. */}
      <div className="min-h-svh bg-panel md:wallpaper md:h-svh md:p-3.5">
        <div className="md:window-rim md:h-full md:rounded-[30px] md:p-[9px]">
          {/* The transform makes the menu's fixed position count from this shell, not from the screen. */}
          <div className="relative md:h-full md:overflow-hidden md:rounded-[22px] md:bg-shell md:hairline md:[transform:translateZ(0)]">
            <SidebarProvider className="md:h-full md:min-h-0" defaultOpen={!document.cookie.split('; ').includes('sidebar_state=false')}>
              <Sidebar variant="inset" collapsible="icon" className="md:h-full">
                <SidebarHeader className="px-2 pt-3">
                  <SidebarMenu>
                    <SidebarMenuItem className="flex items-center justify-between gap-2">
                      <OrgPicker orgs={orgs} org={org} onPick={onPickOrg} />
                      <SidebarTrigger className="size-8 rounded-[8px] text-ink-3 hover:bg-white/[0.05] hover:text-ink group-data-[collapsible=icon]:hidden max-md:hidden" />
                    </SidebarMenuItem>
                  </SidebarMenu>
                </SidebarHeader>
                <SidebarContent className="gap-3 px-1 pt-3">
                  {VIEWS.map((g) => {
                    const items = (
                      <SidebarMenu className="gap-1">
                        {g.items.map((item) => (
                          <SidebarMenuItem key={item.id}>
                            <NavButton active={view === item.id} label={item.label} icon={item.icon} onClick={() => onView(item.id)} />
                          </SidebarMenuItem>
                        ))}
                      </SidebarMenu>
                    );
                    return g.group === 'Overview' ? (
                      <SidebarGroup key={g.group} className="py-1">
                        <SidebarGroupContent>{items}</SidebarGroupContent>
                      </SidebarGroup>
                    ) : (
                      <NavGroup key={g.group} title={g.group}>
                        {items}
                      </NavGroup>
                    );
                  })}
                </SidebarContent>
                <SidebarFooter className="px-2 pb-3">
                  <SidebarMenu className="gap-0.5">
                    <SidebarMenuItem>
                      <SidebarMenuButton size="sm" tooltip="Support" className="h-8 gap-2.5 rounded-[8px]! px-2.5 text-[13.5px] text-ink-3 [&_svg]:text-[#82827f] hover:bg-white/[0.04] hover:text-ink" render={<a href={`mailto:${EMAIL}?subject=Mergelight%20support`} />}>
                        <LifeBuoyIcon />
                        <span>Support</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <SidebarMenuButton size="sm" tooltip="Feedback" className="h-8 gap-2.5 rounded-[8px]! px-2.5 text-[13.5px] text-ink-3 [&_svg]:text-[#82827f] hover:bg-white/[0.04] hover:text-ink" render={<a href={`${GITHUB}/issues/new`} target="_blank" rel="noreferrer" />}>
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
              <SidebarInset className="min-w-0 bg-panel md:min-h-0 md:overflow-y-auto md:hairline md:peer-data-[variant=inset]:rounded-[16px] md:peer-data-[variant=inset]:shadow-none">
                <header className="flex h-14 shrink-0 items-center gap-2 px-5 md:px-6">
                  <PanelTrigger />
                  <h1 className="truncate text-[15px] font-medium text-ink">{here.label}</h1>
                  <div className="ml-auto flex items-center gap-2">
                    {loadedAt && <Updated at={loadedAt} />}
                    <PageMenu orgLogin={org.login} onRefresh={onRefresh} />
                  </div>
                </header>
                <div className="flex w-full flex-1 flex-col px-5 pb-8 pt-6 md:px-10 md:pt-10">{children}</div>
              </SidebarInset>
            </SidebarProvider>
          </div>
        </div>
      </div>
      {/* Outside the page region, so a message shows above an open form window. Sonner announces it to screen readers. */}
      <Toaster position="bottom-right" />
    </TooltipProvider>
  );
}

/** A view's title and the line under it, as the reference's "Hey Sam" and "Here's how Acme is running right now." */
export function ViewHeader({ title, lead, action }: { eyebrow?: string; title: ReactNode; lead?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="max-w-2xl">
        <h2 className="text-[26px] font-semibold leading-[1.15] tracking-[-0.02em] text-ink [text-wrap:balance]">{title}</h2>
        {lead && <p className="mt-2 text-[15px] leading-relaxed text-ink-3 [text-wrap:pretty]">{lead}</p>}
      </div>
      {action}
    </div>
  );
}

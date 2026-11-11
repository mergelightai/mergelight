// The dashboard's icons, from Hugeicons (the set the landing page uses). Each one is named for
// what it shows on the page, so a component imports "the info icon", not a set's catalogue name.
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import {
  Add01Icon,
  Alert02Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  ArrowUp01Icon,
  ArrowUpRight01Icon,
  Brain02Icon,
  Cancel01Icon,
  CancelCircleIcon,
  CheckListIcon,
  CheckmarkCircle02Icon,
  CustomerSupportIcon,
  GitPullRequestIcon as GitPullRequest,
  InformationCircleIcon,
  LegalDocument01Icon,
  LinkSquare02Icon,
  Loading03Icon,
  Logout01Icon,
  MoreHorizontalIcon,
  PuzzleIcon as Puzzle,
  RefreshIcon,
  SentIcon,
  SidebarLeftIcon,
  SquareLock02Icon,
  Tick02Icon,
  UnfoldMoreIcon,
} from '@hugeicons/core-free-icons';

export type IconProps = { className?: string; strokeWidth?: number };
export type Icon = (props: IconProps) => React.JSX.Element;

/** Size comes from the class, or from the parent's [&_svg] rule, as with any other icon set. */
const make =
  (icon: IconSvgElement): Icon =>
  ({ className, strokeWidth = 1.8 }) => <HugeiconsIcon icon={icon} className={className} strokeWidth={strokeWidth} aria-hidden="true" />;

export const PlusIcon = make(Add01Icon);
export const TriangleAlertIcon = make(Alert02Icon);
export const ChevronDownIcon = make(ArrowDown01Icon);
export const ChevronRightIcon = make(ArrowRight01Icon);
export const ChevronUpIcon = make(ArrowUp01Icon);
export const ArrowUpRightIcon = make(ArrowUpRight01Icon);
export const BrainIcon = make(Brain02Icon);
export const XIcon = make(Cancel01Icon);
export const CircleXIcon = make(CancelCircleIcon);
export const ListChecksIcon = make(CheckListIcon);
export const CircleCheckIcon = make(CheckmarkCircle02Icon);
export const LifeBuoyIcon = make(CustomerSupportIcon);
export const GitPullRequestIcon = make(GitPullRequest);
export const InfoIcon = make(InformationCircleIcon);
export const ScrollTextIcon = make(LegalDocument01Icon);
export const ExternalLinkIcon = make(LinkSquare02Icon);
export const LoaderCircleIcon = make(Loading03Icon);
export const LogOutIcon = make(Logout01Icon);
export const EllipsisIcon = make(MoreHorizontalIcon);
export const PuzzleIcon = make(Puzzle);
export const RotateCwIcon = make(RefreshIcon);
export const SendIcon = make(SentIcon);
export const PanelLeftIcon = make(SidebarLeftIcon);
export const LockIcon = make(SquareLock02Icon);
export const CheckIcon = make(Tick02Icon);
export const ChevronsUpDownIcon = make(UnfoldMoreIcon);

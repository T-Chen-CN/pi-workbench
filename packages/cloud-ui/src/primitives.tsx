/**
 * Paper & Ink 共享原语再导出层：唯一实现位于 `@pi-workbench/ui`（零桌面 store / Electron 依赖）。
 * 保留既有类型别名导出以确保外部调用方与测试 100% 兼容。
 */

export {
  Button,
  Caption,
  Card,
  CardHeader,
  DataText,
  EmptyState,
  Eyebrow,
  Field,
  IconButton,
  Input,
  Label,
  Modal,
  Select,
  Spinner,
  StatusText,
  Tab,
  Textarea,
  Value,
  type ButtonProps,
  type ButtonVariant as CloudButtonVariant,
  type CardHeaderProps,
  type CardProps,
  type ControlSize as CloudControlSize,
  type EmptyStateProps,
  type FieldProps,
  type IconButtonProps,
  type ModalProps,
  type SelectProps,
  type StatusTextProps,
  type StatusTone as CloudStatusTone,
  type TabProps,
} from '@pi-workbench/ui'

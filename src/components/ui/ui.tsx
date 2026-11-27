/**
 * 桌面端 Paper & Ink UI 原语兼容再导出层：唯一实现位于 `@pi-workbench/ui`。
 */
import {
  Button as UiButton,
  Caption as UiCaption,
  DataText as UiDataText,
  EmptyState as UiEmptyState,
  Eyebrow as UiEyebrow,
  Field as UiField,
  IconButton as UiIconButton,
  Input as UiInput,
  Label as UiLabel,
  MenuOption as UiMenuOption,
  Modal as UiModal,
  OverlayButton as UiOverlayButton,
  PopoverMenu as UiPopoverMenu,
  Select as UiSelect,
  Spinner as UiSpinner,
  Textarea as UiTextarea,
  Value as UiValue,
} from '@pi-workbench/ui'

export type {
  ButtonProps,
  ButtonVariant,
  ControlSize,
  EmptyStateProps,
  FieldProps,
  IconButtonProps,
  MenuOptionProps,
  ModalProps,
  OverlayButtonProps,
  PopoverMenuProps,
  SelectProps,
  TextPrimitiveProps,
} from '@pi-workbench/ui'

export const Label = UiLabel
export const Value = UiValue
export const Caption = UiCaption
export const DataText = UiDataText
export const Eyebrow = UiEyebrow
export const Button = UiButton
export const IconButton = UiIconButton
export const OverlayButton = UiOverlayButton
export const Input = UiInput
export const Textarea = UiTextarea
export const Select = UiSelect
export const PopoverMenu = UiPopoverMenu
export const MenuOption = UiMenuOption
export const Field = UiField
export const EmptyState = UiEmptyState
export const Modal = UiModal
export const Spinner = UiSpinner

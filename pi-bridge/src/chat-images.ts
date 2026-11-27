/** 聊天图片附件的通用上限与校验（复用浏览器安全入口 `./images.js`） */
export {
  CHAT_IMAGE_MIME,
  MAX_CHAT_IMAGES,
  MAX_IMAGE_BASE64_CHARS,
  MAX_TOTAL_IMAGE_BASE64_CHARS,
  validateChatImages,
  type ChatImageInput,
} from './images.js'

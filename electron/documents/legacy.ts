/**
 * 旧版 OLE 二进制格式（.doc / .xls / .ppt / WPS 系）的统一拒绝文案。
 *
 * 这些格式没有免费、可靠、零外部程序的解析路径：要么引 OLE 复合文档解析器再逆
 * 二进制文本流，要么装 LibreOffice 转换。两者都与「零外部程序、离线开箱」冲突，
 * 而且用户手里基本都有 Office / WPS，另存一次即可——所以这里只给可执行的指引。
 */

const FORMAT_ADVICE: Record<string, { name: string; target: string; app: string }> = {
  doc: { name: 'Word 97-2003 文档', target: '.docx', app: 'Word / WPS 文字' },
  dot: { name: 'Word 97-2003 模板', target: '.docx', app: 'Word / WPS 文字' },
  xls: { name: 'Excel 97-2003 工作簿', target: '.xlsx', app: 'Excel / WPS 表格' },
  xlt: { name: 'Excel 97-2003 模板', target: '.xlsx', app: 'Excel / WPS 表格' },
  xla: { name: 'Excel 加载项', target: '.xlsx', app: 'Excel / WPS 表格' },
  ppt: { name: 'PowerPoint 97-2003 演示文稿', target: '.pptx', app: 'PowerPoint / WPS 演示' },
  pot: { name: 'PowerPoint 97-2003 模板', target: '.pptx', app: 'PowerPoint / WPS 演示' },
  pps: { name: 'PowerPoint 97-2003 放映文件', target: '.pptx', app: 'PowerPoint / WPS 演示' },
  wps: { name: 'WPS 文字旧格式', target: '.docx', app: 'WPS 文字' },
  et: { name: 'WPS 表格旧格式', target: '.xlsx', app: 'WPS 表格' },
  dps: { name: 'WPS 演示旧格式', target: '.pptx', app: 'WPS 演示' },
}

export function legacyOfficeMessage(extension: string): string {
  const advice = FORMAT_ADVICE[extension.toLowerCase()]
  if (!advice) {
    return [
      '这是旧版 Office 二进制格式，当前不支持读取。',
      '请用 Office 或 WPS 打开后「另存为」.docx / .xlsx / .pptx，再用同样的路径读一次。',
    ].join('\n')
  }
  return [
    `这是${advice.name}（.${extension.toLowerCase()}），当前只支持读取新的 Office 开放格式。`,
    `请用 ${advice.app} 打开后「另存为」${advice.target}，再读取新文件即可。`,
    '（旧格式需要外部转换器才能解析，本程序为保证离线可用不做内置支持。）',
  ].join('\n')
}

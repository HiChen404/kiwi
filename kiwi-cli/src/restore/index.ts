/**
 * @author doubledream
 * @desc 提取指定文件夹下的中文
 */
import * as Bun from 'bun';
import * as _ from 'lodash';
import * as slash from 'slash2';
import * as path from 'path';
import * as colors from 'colors';
import { getSpecifiedFiles, readFile, writeFile, isFile, isDirectory } from '../extract/file';
import { findChineseText } from './findChineseText';
import { getSuggestLangObj } from '../extract/getLangData';
import {
  translateText,
  findMatchKey,
  findMatchValue,
  translateKeyText,
  successInfo,
  failInfo,
  highlightText
} from '../utils';
import { replaceAndUpdate, hasImportI18N, createImportI18N } from '../extract/replace';
import { getProjectConfig } from '../utils';

const CONFIG = getProjectConfig();

/**
 * 剔除 kiwiDir 下的文件
 */
function removeLangsFiles(files: string[]) {
  const langsDir = path.resolve(process.cwd(), CONFIG.kiwiDir);
  return files.filter(file => {
    const completeFile = path.resolve(process.cwd(), file);
    return !completeFile.includes(langsDir);
  });
}

/**
 * 递归匹配项目中所有的代码的中文
 */
function findAllRestoreText(dir: string, restoreFnList: string[]) {
  const first = dir.split(',')[0];
  let files = [];
  if (isDirectory(first)) {
    const dirPath = path.resolve(process.cwd(), dir);
    files = getSpecifiedFiles(dirPath, CONFIG.ignoreDir, CONFIG.ignoreFile);
  } else {
    files = removeLangsFiles(dir.split(','));
  }
  const filterFiles = files.filter(file => {
    return (
      (isFile(file) && file.endsWith('.ts')) ||
      file.endsWith('.tsx') ||
      file.endsWith('.vue') ||
      file.endsWith('.js') ||
      file.endsWith('.jsx')
    );
  });
  const allTexts = filterFiles.reduce((pre, file) => {
    const code = readFile(file);
    const texts = findChineseText(code, file, restoreFnList);
    // 调整文案顺序，保证从后面的文案往前替换，避免位置更新导致替换出错
    const sortTexts = _.sortBy(texts, obj => -obj.range.start);
    console.log('🚀 -> allTexts -> sortTexts:', sortTexts);
    if (texts.length > 0) {
      console.log(`${highlightText(file)} 发现 ${highlightText(texts.length)} 处中文文案`);
    }

    return texts.length > 0 ? pre.concat({ file, texts: sortTexts.map(text => text) }) : pre;
  }, []);

  return allTexts;
}

/**
 * 处理作为key值的翻译原文
 */
function getTransOriginText(text: string) {
  // 避免翻译的字符里包含数字或者特殊字符等情况，只过滤出汉字和字母
  const reg = /[a-zA-Z\u4e00-\u9fa5]+/g;
  const findText = text.match(reg) || [];
  const transOriginText = findText ? findText.join('').slice(0, 5) : '中文符号';

  return transOriginText;
}

/**
 * @param currentFilename 文件路径
 * @returns string[]
 */
function getSuggestion(currentFilename: string) {
  let suggestion = [];
  const suggestPageRegex = /\/pages\/\w+\/([^\/]+)\/([^\/\.]+)/;

  if (currentFilename.includes('/pages/')) {
    suggestion = currentFilename.match(suggestPageRegex);
  }
  if (suggestion) {
    suggestion.shift();
  }
  /** 如果没有匹配到 Key */
  if (!(suggestion && suggestion.length)) {
    const names = slash(currentFilename).split('/');
    const fileName = _.last(names) as any;
    const fileKey = fileName.split('.')[0].replace(new RegExp('-', 'g'), '_');
    const dir = names[names.length - 2].replace(new RegExp('-', 'g'), '_');
    if (dir === fileKey) {
      suggestion = [dir];
    } else {
      suggestion = [dir, fileKey];
    }
  }

  return suggestion;
}

/**
 * 统一处理key值，已提取过的文案直接替换，翻译后的key若相同，加上出现次数
 * @param currentFilename 文件路径
 * @param langsPrefix 替换后的前缀
 * @param translateTexts 翻译后的key值
 * @param targetStrs 当前文件提取后的文案
 * @returns any[] 最终可用于替换的key值和文案
 */
function getReplaceableStrs(currentFilename: string, langsPrefix: string, translateTexts: string[], targetStrs: any[]) {
  const finalLangObj = getSuggestLangObj();
  const virtualMemory = {};
  const suggestion = getSuggestion(currentFilename);
  const replaceableStrs = targetStrs.reduce((prev, curr, i) => {
    const _text = curr.text;
    let key = findMatchKey(finalLangObj, _text);
    if (key) {
      key = key.replace(/-/g, '_');
    }
    if (!virtualMemory[_text]) {
      if (key) {
        virtualMemory[_text] = key;
        return prev.concat({
          target: curr,
          key,
          needWrite: false
        });
      }
      const transText = translateTexts[i] && _.camelCase(translateTexts[i] as string);
      let transKey = `${suggestion.length ? suggestion.join('.') + '.' : ''}${transText}`;
      transKey = transKey.replace(/-/g, '_');
      if (langsPrefix) {
        transKey = `${langsPrefix}.${transText}`;
      }
      let occurTime = 1;
      // 防止出现前四位相同但是整体文案不同的情况
      while (
        findMatchValue(finalLangObj, transKey) !== _text &&
        _.keys(finalLangObj).includes(`${transKey}${occurTime >= 2 ? occurTime : ''}`)
      ) {
        occurTime++;
      }
      if (occurTime >= 2) {
        transKey = `${transKey}${occurTime}`;
      }
      virtualMemory[_text] = transKey;
      finalLangObj[transKey] = _text;
      return prev.concat({
        target: curr,
        key: transKey,
        needWrite: true
      });
    } else {
      return prev.concat({
        target: curr,
        key: virtualMemory[_text],
        needWrite: true
      });
    }
  }, []);

  return replaceableStrs;
}

/**
 * 递归匹配项目中所有的代码的中文
 * @param {dirPath} 文件夹路径
 */
async function restoreAll({
  dirPath,
  prefix,
  filePath,
  restoreFnList
}: {
  dirPath?: string;
  prefix?: string;
  filePath?: string;
  restoreFnList: string[];
}) {
  const dir = dirPath || './';

  const langsPrefix = prefix ? prefix.replace(/^I18N\./, '') : null;

  const allTargetStrs = findAllRestoreText(dir, restoreFnList) as {
    file: string;
    texts: { range: { start: number; end: number }; text: string }[];
  }[];

  for (const item of allTargetStrs) {
    const { file, texts } = item;
    let code = readFile(file);
    for (const {
      range: { start, end },
      text
    } of texts) {
      const obj = (await require(filePath)).default;
      const realText = _.get(obj, text.split('.').join('.'));
      console.log('🚀 -> restoreAll -> realText:', realText);
      // const realText = _.get((await import('./text.js')).default, text);

      // const res = await import('./test.js');
      // const res = (await import('../../../test/.kiwi/zh-CN/index.js')).default;
      // console.log('🚀 -> restoreAll -> res:', res);
      code = code.slice(0, start) + `'${realText}'` + code.slice(end);
    }

    writeFile(file, code);
  }
}

export { restoreAll };

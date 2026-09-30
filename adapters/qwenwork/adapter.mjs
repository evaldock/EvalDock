import {createOfficeAdapter} from '../shared/office-adapter.mjs';
import {QwenDesktop,runQwen} from './desktop.mjs';
export const createQwenWorkAdapter=target=>createOfficeAdapter(target,{app:'/Applications/QwenWorkCN.app',bundle:'cn.qwenwork.desktop.mac',version:'1.2.1',port:18492,Desktop:QwenDesktop,run:runQwen,limitations:['千问办公 1.2.1 桌面任务接口；升级后需重新验证。','只支持文本与独立 Case 工作目录文件，不支持原生聊天附件。','按 subChatId 订阅推送；工具调用和结果合并，最终文本最多 64 KiB。','不声明完整工具清单，不采集内部推理，不自动重置应用全局状态。']});

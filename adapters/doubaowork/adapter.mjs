import {createOfficeAdapter} from '../shared/office-adapter.mjs';
import {DoubaoDesktop,runDoubao} from './desktop.mjs';
export const createDoubaoWorkAdapter=target=>createOfficeAdapter(target,{app:'/Applications/DoubaoWork.app',bundle:'com.work.pc.doubao',port:18493,Desktop:DoubaoDesktop,run:runDoubao,limitations:['按桌面接口、登录状态与本机执行环境检查准入；任务执行在运行时验证。','每题独立工作目录和会话，支持测试文件输入及真实文件交付；沿用应用当前授权设置。','由新任务卡触发一次后台线程初始化，之后订阅事件；主聊天结束不等于后台任务结束。','保留关键工具调用、结果及最终回复；同一工具状态合并，内部推理和未暴露工具不推断。','暂不支持原生聊天附件；本地文件通过 Case 工作目录提供。']});

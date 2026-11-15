import { mount, View } from 'nsh';
import { Sidebar } from '../Sidebar';
import { applyShellEventForTest } from '../../store';
const project = { id:'p', title:'Project', workspaceRoot:'/tmp' };
const thread = (n: number) => ({ id:'t', projectId:'p', title:`Live thread ${n}`, status:'running', activeRunId:'r', latestRunId:'r', activityRunStatus:'running', activityRunStartedAt:'2026-11-13T12:00:00Z', updatedAt:new Date(1763035200000+n*1000).toISOString(), createdAt:'2026-11-13T12:00:00Z' });
applyShellEventForTest({kind:'snapshot',snapshot:{projects:[project],threads:[thread(0)]}});
let n=0; setInterval(() => applyShellEventForTest({kind:'thread.updated',location:'active',thread:thread(++n)}), 150);
mount(() => <View class="h-[600px] w-[320px] flex-row"><Sidebar /></View>);

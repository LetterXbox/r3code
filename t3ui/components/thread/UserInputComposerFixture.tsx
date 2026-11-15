import { mount, signal, Text, View } from 'nsh';
import { Composer } from '../Composer';
import { applyShellEventForTest, backendUrl, composerDraft, createThread, openThread, setBackendStatusForTest, setComposerDraft } from '../../store';
import { UserInputPanel, type UserInputDisplay } from './UserInputPanel';
applyShellEventForTest({kind:'snapshot',snapshot:{projects:[{id:'p',title:'Project'}],threads:[]}});
createThread('p'); setBackendStatusForTest('connected'); setComposerDraft('saved draft');
const requests=signal<UserInputDisplay[]>([{id:'question',title:'Input requested',questions:[{id:'answer',header:'Question',question:'Choose one',multiSelect:false,allowCustomAnswer:true,required:true,options:[{label:'First',description:'',value:'one'}]}]}]);
const result=signal('');
function Fixture(){return <View class="flex-1"><UserInputPanel integrated scope={()=>JSON.stringify([backendUrl(),openThread()?.id ?? ''])} threadId={()=>openThread()?.id ?? ''} requests={requests} onRespond={async (_id,answers)=>{result.set(JSON.stringify(answers));requests.set([]);}}/><Composer/><Text>{result()}</Text><Text>{`draft:${composerDraft()}`}</Text></View>;}
mount(Fixture);

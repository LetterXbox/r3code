import { mount, signal, Text, View } from 'nsh';
import { Input } from 'nsh/base';
import { UserInputPanel, type UserInputDisplay } from './UserInputPanel';
import { composerQuestionControls } from './userInputControls';
const requests = signal<UserInputDisplay[]>([{id:'q',title:'Input requested',questions:[{id:'answer',header:'Question',question:'Choose one',multiSelect:false,allowCustomAnswer:true,required:true,options:[{label:'First',description:'',value:'one'},{label:'Second',description:'',value:'two'}]}]}]);
const result = signal('');
function Fixture() {
 const controls=()=>composerQuestionControls('integrated-test');
 return <View><UserInputPanel integrated scope={()=>'integrated-test'} requests={requests} onRespond={async (_id,answers)=>{result.set(JSON.stringify(answers));requests.set([]);}} />
 <Input accessibilityLabel="Composer answer" value={controls()?.text ?? ''} onChange={(event)=>controls()?.setText(event.value)} />
 <View role="button" accessibilityLabel="Composer submit" disabled={!controls()?.canAdvance} onPress={()=>controls()?.advance()}><Text>Submit</Text></View><Text>{result()}</Text></View>;
}
mount(Fixture);

"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import {ArrowRight,Bell,RefreshCw} from "lucide-react";
import {api,date,go,notify} from "../lib/api";
import {Empty} from "./common";

type Notice={
  id:string;
  resource_id:string;
  message:string;
  created_at:string;
  read_at:string|null;
};

export default function NotificationInbox(){
  const [rows,setRows]=useState<Notice[]>([]);
  const [filter,setFilter]=useState("");
  const [onlyUnread,setOnlyUnread]=useState(false);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState(false);
  const [opening,setOpening]=useState("");
  const requestGeneration=useRef(0);
  const refresh=useCallback(async()=>{
    const generation=++requestGeneration.current;
    // Never keep showing a previous ACL snapshot while current authority
    // is being rechecked or a newer focus-refresh is still in flight.
    setRows([]);
    setLoading(true);
    try {
      // Server filters against CURRENT tenant membership and resource ACL.
      // Never persist previously visible notifications in local storage.
      const current=await api("/notifications");
      if(generation!==requestGeneration.current)return;
      setRows(current);
      setError(false);
    } catch {
      if(generation!==requestGeneration.current)return;
      setRows([]);
      setError(true);
    } finally {
      if(generation===requestGeneration.current)setLoading(false);
    }
  },[]);
  useEffect(()=>{
    void refresh();
    const onFocus=()=>{void refresh();};
    window.addEventListener("focus",onFocus);
    return ()=>{
      window.removeEventListener("focus",onFocus);
      requestGeneration.current++;
    };
  },[refresh]);
  const unreadCount=rows.filter(item=>!item.read_at).length;
  const visible=rows.filter(item=>
    item.message.toLocaleLowerCase().includes(filter.toLocaleLowerCase()) &&
      (!onlyUnread || !item.read_at));
  async function setRead(item:Notice,read:boolean):Promise<boolean>{
    try{
      const result=await api("/notifications/"+item.id,"PATCH",{read});
      setRows(previous=>previous.map(x=>
        x.id===item.id?{...x,read_at:result.read_at}:x));
      return true;
    }catch{
      notify("Read state could not be saved. Checking access again.");
      await refresh();
      return false;
    }
  }
  async function open(item:Notice){
    if(opening)return;
    setOpening(item.id);
    try {
      // Enforce a fresh authority check before navigating an old inbox item.
      await api("/resources/"+item.resource_id);
      if(!(await setRead(item,true)))return;
      go(item.resource_id);
    }catch{
      notify("This item is no longer available to your account.");
      await refresh();
    }finally{setOpening("");}
  }
  return <section className="dashboard" aria-labelledby="notification-inbox-title">
    <div className="section-title">
      <div>
        <h1 id="notification-inbox-title">Inbox</h1>
        <p className="muted">Your recent mentions and updates on pages you can access.</p>
      </div>
      <button type="button" className="button small-button"
        onClick={()=>void refresh()} disabled={loading}>
        <RefreshCw size={15}/> Refresh
      </button>
    </div>
    <label className="field">
      <span>Filter notifications</span>
      <input value={filter} onChange={event=>setFilter(event.target.value)}
        aria-label="Filter notifications" placeholder="Find a notification…" maxLength={120}/>
    </label>
    <label className="checkbox-line">
      <input type="checkbox" aria-label="Unread only"
        checked={onlyUnread} onChange={event=>setOnlyUnread(event.target.checked)}/>
      Unread only ({unreadCount})
    </label>
    <p className="muted small-text" role="status" aria-live="polite">
      {loading?"Checking access…":error?"Could not securely load notifications":
        `${visible.length} accessible notification${visible.length===1?"":"s"} shown${rows.length===100?" (latest 100)":""}`}
    </p>
    {error?<div role="alert">
      <p>Notifications are unavailable. Nothing has been cached from the previous request.</p>
      <button type="button" className="button" onClick={()=>void refresh()}>Try again</button>
    </div>:visible.length?
      <div className="notification-inbox-list" role="list" aria-label="Notifications">
        {visible.map(item=><div role="listitem" key={item.id}
          className={`notification-inbox-row ${item.read_at?"is-read":"is-unread"}`}>
          <button type="button" className="notification"
            disabled={!!opening}
            onClick={()=>void open(item)}
            aria-label={`Open notification: ${item.message}`}>
            <Bell size={17} aria-hidden="true"/>
            <span className="notification-inbox-copy">
              <strong>{item.message}</strong>
              <small>{date(item.created_at)} · {item.read_at?"Read":"Unread"}</small>
            </span>
            <ArrowRight size={16} aria-hidden="true"/>
          </button>
          <button type="button" className="button small-button"
            disabled={!!opening}
            aria-label={`${item.read_at?"Mark unread":"Mark read"}: ${item.message}`}
            onClick={()=>void setRead(item,!item.read_at)}>
            {item.read_at?"Mark unread":"Mark read"}
          </button>
        </div>)}
      </div>:!loading?<Empty title={rows.length?"No notifications match your filter.":"You're all caught up."}>
        <p>{rows.length?"Try different search words.":"Mentions you can access will appear here."}</p>
      </Empty>:null}
  </section>;
}

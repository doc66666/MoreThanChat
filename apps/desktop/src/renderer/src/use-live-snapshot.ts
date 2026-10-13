import { useEffect, useRef, useState } from 'react'
import { LiveSnapshot, type SnapshotState } from './live-snapshot'

export function useLiveSnapshot<T>(read: () => Promise<T>, subscribe: (listener: (value: T) => void) => () => void) {
  const [state,setState]=useState<SnapshotState<T>>({value:null,loading:true,error:''})
  const controller=useRef<LiveSnapshot<T>|null>(null)
  if(!controller.current)controller.current=new LiveSnapshot(read,subscribe,setState)
  useEffect(()=>{void controller.current!.start();return()=>controller.current!.stop()},[])
  return {...state,refresh:()=>controller.current!.refresh()}
}

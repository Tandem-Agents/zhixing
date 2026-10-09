/* Optional Xlib ABI, loaded only in the S-owned clipboard helper. The public
 * event layout is specified by Xlib.h; no X server is required at startup. */
#ifdef __linux__
#include <dlfcn.h>
#include <time.h>
typedef struct _XDisplay ZxDisplay;
typedef unsigned long ZxId;
typedef struct { int type; unsigned long serial; int sent; ZxDisplay *display;
  ZxId owner, requestor, selection, target, property, time; } ZxRequest;
typedef struct { int type; unsigned long serial; int sent; ZxDisplay *display;
  ZxId requestor, selection, target, property, time; } ZxNotify;
typedef struct { int type; unsigned long serial; int sent; ZxDisplay *display;
  ZxId window, atom, time; int state; } ZxProperty;
typedef union { int type; long pad[24]; ZxRequest request; ZxNotify notify; ZxProperty property; } ZxEvent;
#define ZX_X_FUNCTIONS(X) \
 X(ZxDisplay*,OpenDisplay,(const char*)) X(ZxId,DefaultRootWindow,(ZxDisplay*)) \
 X(ZxId,CreateSimpleWindow,(ZxDisplay*,ZxId,int,int,unsigned,unsigned,unsigned,unsigned long,unsigned long)) \
 X(ZxId,InternAtom,(ZxDisplay*,const char*,int)) X(int,SetSelectionOwner,(ZxDisplay*,ZxId,ZxId,ZxId)) \
 X(ZxId,GetSelectionOwner,(ZxDisplay*,ZxId)) X(int,Sync,(ZxDisplay*,int)) \
 X(int,Pending,(ZxDisplay*)) X(int,NextEvent,(ZxDisplay*,ZxEvent*)) \
 X(int,ChangeProperty,(ZxDisplay*,ZxId,ZxId,ZxId,int,int,const unsigned char*,int)) \
 X(int,SendEvent,(ZxDisplay*,ZxId,int,long,ZxEvent*)) X(int,Flush,(ZxDisplay*)) \
 X(int,SelectInput,(ZxDisplay*,ZxId,long)) X(int,DestroyWindow,(ZxDisplay*,ZxId)) X(int,CloseDisplay,(ZxDisplay*))
#define ZX_DECLARE(ret,name,args) static ret (*zxX##name)args;
ZX_X_FUNCTIONS(ZX_DECLARE)
#undef ZX_DECLARE
static void *zx_xlib;
static ZxDisplay *zx_display;
static ZxId zx_window, zx_clipboard, zx_utf8, zx_targets, zx_plain, zx_incr;
static unsigned char *zx_cliptext;
static size_t zx_clipsize;
typedef struct { ZxId window, property, target; size_t offset; long long deadline; } ZxTransfer;
static ZxTransfer zx_transfers[8];
static long long zx_cliptime(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC,&t); return (long long)t.tv_sec*1000+t.tv_nsec/1000000; }
static int zx_cliperror(ZxDisplay *d,void *event) { (void)d;(void)event;return 0; }
static void zx_clipclose(void) {
  if(zx_display){if(zx_window)zxXDestroyWindow(zx_display,zx_window);zxXCloseDisplay(zx_display);}
  zx_display=NULL;zx_window=0;
  if(zx_cliptext){memset(zx_cliptext,0,zx_clipsize);free(zx_cliptext);zx_cliptext=NULL;}
  zx_clipsize=0;memset(zx_transfers,0,sizeof zx_transfers);
}
static napi_value write_x_clipboard(napi_env env,napi_callback_info info) {
  napi_value arg,result;size_t count=1,length=0;void *data=NULL;double receipt=0;
  if(zx_display||napi_get_cb_info(env,info,&count,&arg,NULL,NULL)!=napi_ok||count!=1||
     napi_get_buffer_info(env,arg,&data,&length)!=napi_ok||!length||length>224*1024)return fail(env,"terminal-clipboard-input");
  zx_xlib=dlopen("libX11.so.6",RTLD_NOW|RTLD_LOCAL);
  if(!zx_xlib)goto done;
#define ZX_LOAD(ret,name,args) zxX##name=dlsym(zx_xlib,"X" #name);if(!zxX##name)goto done;
  ZX_X_FUNCTIONS(ZX_LOAD)
#undef ZX_LOAD
  /* This helper owns its own connection and process-wide handler. A requestor
   * disappearing is ordinary; it must not kill the accepted selection owner. */
  void *(*set_error)(int(*)(ZxDisplay*,void*))=dlsym(zx_xlib,"XSetErrorHandler");
  if(!set_error)goto done;set_error(zx_cliperror);
  zx_display=zxXOpenDisplay(NULL);if(!zx_display)goto done;
  zx_window=zxXCreateSimpleWindow(zx_display,zxXDefaultRootWindow(zx_display),0,0,1,1,0,0,0);
  zx_clipboard=zxXInternAtom(zx_display,"CLIPBOARD",0);zx_utf8=zxXInternAtom(zx_display,"UTF8_STRING",0);
  zx_plain=zxXInternAtom(zx_display,"text/plain;charset=utf-8",0);zx_targets=zxXInternAtom(zx_display,"TARGETS",0);zx_incr=zxXInternAtom(zx_display,"INCR",0);
  if(!zx_window||!zx_clipboard||!zx_utf8||!zx_plain||!zx_targets||!zx_incr)goto done;
  zx_cliptext=malloc(length);if(!zx_cliptext)goto done;memcpy(zx_cliptext,data,length);zx_clipsize=length;
  receipt=-1; /* Ownership may change from this point: never try another writer. */
  zxXSetSelectionOwner(zx_display,zx_clipboard,zx_window,0);zxXSync(zx_display,0);
  if(zxXGetSelectionOwner(zx_display,zx_clipboard)==zx_window)receipt=(double)zx_window;
done:
  if(receipt<=0)zx_clipclose();napi_create_double(env,receipt,&result);return result;
}
static napi_value poll_x_clipboard(napi_env env,napi_callback_info info) {
  (void)info;bool alive=zx_display&&zx_window;
  for(int n=0;alive&&n<64&&zxXPending(zx_display);n++){
    ZxEvent event={0};zxXNextEvent(zx_display,&event);
    if(event.type==29){alive=false;break;} /* SelectionClear: never reclaim. */
    if(event.type==30){
      ZxRequest r=event.request;ZxId property=r.property?r.property:r.target;
      ZxEvent reply={0};reply.notify=(ZxNotify){31,0,1,zx_display,r.requestor,r.selection,r.target,0,r.time};
      if(r.owner==zx_window&&r.selection==zx_clipboard&&r.target==zx_targets){
        ZxId atoms[]={zx_targets,zx_utf8,zx_plain};zxXChangeProperty(zx_display,r.requestor,property,4,32,0,(unsigned char*)atoms,3);reply.notify.property=property;
      }else if(r.owner==zx_window&&r.selection==zx_clipboard&&(r.target==zx_utf8||r.target==zx_plain)){
        if(zx_clipsize<=16384){zxXChangeProperty(zx_display,r.requestor,property,r.target,8,0,zx_cliptext,(int)zx_clipsize);reply.notify.property=property;}
        else for(size_t i=0;i<8;i++)if(!zx_transfers[i].window){
          zx_transfers[i]=(ZxTransfer){r.requestor,property,r.target,0,zx_cliptime()+5000};
          zxXSelectInput(zx_display,r.requestor,1L<<22);unsigned long size=zx_clipsize;
          zxXChangeProperty(zx_display,r.requestor,property,zx_incr,32,0,(unsigned char*)&size,1);reply.notify.property=property;break;
        }
      }
      zxXSendEvent(zx_display,r.requestor,0,0,&reply);
    }else if(event.type==28&&event.property.state==1){
      for(size_t i=0;i<8;i++){ZxTransfer *t=&zx_transfers[i];if(t->window!=event.property.window||t->property!=event.property.atom)continue;
        size_t count=zx_clipsize-t->offset;if(count>16384)count=16384;
        zxXChangeProperty(zx_display,t->window,t->property,t->target,8,0,zx_cliptext+t->offset,(int)count);
        t->offset+=count;if(!count)memset(t,0,sizeof *t);break;
      }
    }
  }
  for(size_t i=0;i<8;i++)if(zx_transfers[i].window&&zx_transfers[i].deadline<zx_cliptime())memset(&zx_transfers[i],0,sizeof zx_transfers[i]);
  if(alive)zxXFlush(zx_display);else zx_clipclose();napi_value result;napi_get_boolean(env,alive,&result);return result;
}
#endif

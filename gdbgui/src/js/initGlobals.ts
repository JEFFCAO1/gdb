if (typeof window !== "undefined") {

    if (typeof (window as any).debug === "undefined") {
      (window as any).debug = false;
    }
  
    if (typeof (window as any).initial_data === "undefined") {
  
      (window as any).initial_data = {
        csrf_token: "",
        gdbpid: "",
        gdb_command: "",
        remap_sources: {},
      };
    }
  }
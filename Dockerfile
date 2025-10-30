FROM ubuntu:25.10

RUN apt-get update && apt-get install -y python3 python3-pip ssh

EXPOSE 5000
EXPOSE 22
# USER root
CMD /bin/sh -c "./app/gdbgui_0.15.3.0 && /usr/sbin/sshd -D"

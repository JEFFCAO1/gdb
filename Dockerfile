FROM debian:bullseye

# RUN sed -i 's/deb.debian.org/mirrors.ustc.edu.cn/g' /etc/apt/sources.list

# Install OpenSSH server
RUN apt-get update && apt-get install -y openssh-server git gcc g++ make file wget gawk diffstat bzip2 cpio chrpath zstd lz4 bzip2 locales python3 libtinfo5 build-essential libssl-dev libbz2-dev libreadline-dev libsqlite3-dev wget curl llvm libncurses5-dev libncursesw5-dev xz-utils tk-dev libffi-dev liblzma-dev gdb

RUN cd /usr/src && wget https://www.python.org/ftp/python/3.12.0/Python-3.12.0.tgz && tar xzf Python-3.12.0.tgz && cd Python-3.12.0 && ./configure --enable-optimizations && make altinstall
RUN update-alternatives --install /usr/bin/python3 python3 /usr/local/bin/python3.12 1

# Create the SSH directory
RUN mkdir /var/run/sshd

# Set a password for the root user (or create a new user)
RUN echo 'root:toor' | chpasswd

# Allow root login via SSH (optional, for testing purposes)
RUN sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin yes/' /etc/ssh/sshd_config

# locale-gen en_US.UTF-8
RUN sed -i -e 's/# en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen && \
    dpkg-reconfigure --frontend=noninteractive locales

# Start the SSH server
EXPOSE 22
USER root
CMD ["/usr/sbin/sshd", "-D"]

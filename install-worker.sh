#!/bin/sh
#
# Portions Copyright (c) 2017 James Leigh, Some Rights Reserved
#
#  Redistribution and use in source and binary forms, with or without
#  modification, are permitted provided that the following conditions are met:
#
#  1. Redistributions of source code must retain the above copyright notice,
#  this list of conditions and the following disclaimer.
#
#  2. Redistributions in binary form must reproduce the above copyright
#  notice, this list of conditions and the following disclaimer in the
#  documentation and/or other materials provided with the distribution.
#
#  3. Neither the name of the copyright holder nor the names of its
#  contributors may be used to endorse or promote products derived from this
#  software without specific prior written permission.
#
#  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
#  AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
#  IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
#  ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
#  LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
#  CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
#  SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
#  INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
#  CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
#  ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
#  POSSIBILITY OF SUCH DAMAGE.
#

NAME=ptrading-worker

# Read configuration variable file if it is present
[ -r "/etc/default/$NAME" ] && . "/etc/default/$NAME"

# Load the VERBOSE setting and other rcS variables
[ -r /lib/init/vars.sh ] && . /lib/init/vars.sh

if [ "`tty`" != "not a tty" ]; then
  VERBOSE="yes"
fi

# Check if npm is installed
if [ ! -x "$(which npm)" ]; then
  echo "node.js/npm is not installed" 1>&2
  if [ -x "$(which apt-get)" -a "$(id -u)" = "0" ]; then
    read -p "Do you want to install it now? [Y/n]" yes
    if [[ "$yes" =~ ^[Yy]?$ ]]; then
      curl -sL https://deb.nodesource.com/setup_8.x | bash -
      apt-get install nodejs
    fi
  fi
fi
if [ ! -x "$(which npm)" ]; then
  echo "node.js/npm is required to run this program" 1>&2
  exit 5
fi

# install daemon user/group
if [ "$(id -u)" != "0" ]; then
  BASEDIR=$HOME
  DAEMON_USER=$(id -un)
  DAEMON_GROUP=$(id -un)
else
  if [ -z "$DAEMON_USER" ] ; then
    DAEMON_USER=$NAME
  fi
  if [ -z "$DAEMON_GROUP" ] ; then
    DAEMON_GROUP=$NAME
  fi
  if ! grep -q "$DAEMON_GROUP" /etc/group ; then
      groupadd -r "$DAEMON_GROUP"
  fi
  if ! id "$DAEMON_USER" >/dev/null 2>&1 ; then
    BASEDIR=/opt/$NAME
    useradd -d "$BASEDIR" -g "$DAEMON_GROUP" -r "$DAEMON_USER"
    mkdir -p "$BASEDIR"
    echo 'prefix=${HOME}' > "$BASEDIR/.npmrc"
    chown "$DAEMON_USER:$DAEMON_GROUP" "$BASEDIR" "$BASEDIR/.npmrc"
  else
    BASEDIR=$(eval echo ~$DAEMON_USER)
  fi
fi

# Install/upgrade software
sudo -iu "$DAEMON_USER" npm install ptrading/ptrading -g
EXEC=$(sudo -iu "$DAEMON_USER" npm prefix -g)/bin/ptrading

# Setup configuration
if [ ! -f "$BASEDIR/etc/ptrading.json" ]; then
  mkdir -p "$BASEDIR/etc"
  mkdir -p "$BASEDIR/var"
  # generate certificates
  if [ -x "$(which openssl)" ]; then
    if [ -z "$PORT" -a "$(id -u)" = "0" ]; then
      PORT=443
      setcap 'cap_net_bind_service=+ep' $(readlink -f $(which node))
    elif [ "$(id -u)" = "0" -a "$PORT" -lt 1024 ]; then
      setcap 'cap_net_bind_service=+ep' $(readlink -f $(which node))
    elif [ -z "$PORT" ]; then
      PORT=1443
    fi
    if [ ! -f "$BASEDIR/etc/key.pem" ] ; then
      openssl genrsa -out "$BASEDIR/etc/key.pem" 2048
      chmod go-rwx "$BASEDIR/etc/key.pem"
    fi
    if [ ! -f "$BASEDIR/etc/csr.pem" ] ; then
      openssl req -new -sha256 -key "$BASEDIR/etc/key.pem" -out "$BASEDIR/etc/csr.pem"
    fi
    if [ ! -f "$BASEDIR/etc/cert.pem" ] ; then
      openssl x509 -req -in "$BASEDIR/etc/csr.pem" -signkey "$BASEDIR/etc/key.pem" -out "$BASEDIR/etc/cert.pem"
    fi
      cat > "$BASEDIR/etc/ptrading.json" << EOF
{
  "description": "Configuration file for $NAME generated on $(date)",
  "config_dir": "etc",
  "data_dir": "var",
  "listen": "$PORT",
  "key_pem": "etc/key.pem",
  "cert_pem": "etc/cert.pem",
  "ca_pem": "etc/cert.pem"
}
EOF
  else
    if [ -z "$PORT" -a "$(id -u)" = "0" ]; then
      PORT=80
      setcap 'cap_net_bind_service=+ep' $(readlink -f $(which node))
    elif [ "$(id -u)" = "0" -a "$PORT" -lt 1024 ]; then
      setcap 'cap_net_bind_service=+ep' $(readlink -f $(which node))
    elif [ -z "$PORT" ]; then
      PORT=1880
    fi
    cat > "$BASEDIR/etc/ptrading.json" << EOF
{
  "description": "Configuration file for $NAME generated on $(date)",
  "config_dir": "etc",
  "data_dir": "var",
  "listen": "$PORT"
}
EOF
  fi
  chown -R "$DAEMON_USER:$DAEMON_GROUP" "$BASEDIR/etc" "$BASEDIR/var"
fi

# install daemon
if [ ! -f "/etc/systemd/system/$NAME.service" -a -d "/etc/systemd/system/" -a "$(id -u)" = "0" ]; then
  cat > "/etc/systemd/system/$NAME.service" << EOF
[Unit]
Description=$NAME
After=network.target

[Service]
ExecStart=$EXEC start
ExecReload=/bin/kill -HUP $MAINPID
ExecStop=$EXEC stop
Restart=always
User=$DAEMON_USER
Group=$DAEMON_GROUP
Environment=PATH=/usr/bin:/usr/local/bin
Environment=NODE_ENV=production
WorkingDirectory=$BASEDIR

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl start "$NAME"
elif [ -f "/etc/systemd/system/$NAME.service" -a "$(id -u)" = "0" ]; then
  systemctl restart "$NAME"
fi

if [ -f "/etc/systemd/system/$NAME.service" ]; then
  echo "Use 'journalctl --follow -u $NAME' as root to see the output"
fi
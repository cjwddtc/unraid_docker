# coding=utf-8
import time

import requests
#from bs4 import BeautifulSoup
import re
from urllib.parse import urljoin
import subprocess


def get_latest_release(repo_url):
    """
    获取 GitHub 仓库的最新 release 信息，返回 tag 名和资源下载链接。
    :param repo_url: 仓库的 URL。
    :return: tuple(tag_name, download_url)
    """
    # 提取仓库的 owner 和 repo 名
    owner_repo = repo_url.rstrip('/').split('/')[-2:]
    api_url = f"https://api.github.com/repos/{'/'.join(owner_repo)}/releases/latest"

    try:
        response = requests.get(api_url, timeout=15)
        response.raise_for_status()

        # 解析 release 信息
        release_data = response.json()
        tag_name = release_data.get("tag_name", "Unknown")
        assets = release_data.get("assets", [])

        # 获取第一个资源的下载链接
        download_urls = [asset['browser_download_url']  for asset in assets]

        return tag_name, download_urls
    except requests.RequestException as e:
        print(f"Error fetching release data: {e}")
        return None, None


def update_docker_env(key,new_url):
    if new_url is None:
        return
    with open('docker.env', 'r') as file:
        lines = file.readlines()

    with open('docker.env', 'w') as file:
        for line in lines:
            if line.startswith(f"{key}="):
                file.write(f'{key}={new_url}\n')
                print(f'replace {key} {new_url}')
            else:
                file.write(line)

def get_latest_url(pkg_name):
    ret=requests.get(f'https://aur.archlinux.org/cgit/aur.git/plain/PKGBUILD?h={pkg_name}')
    if ret.status_code != 200:
        print("fail",ret.status_code)
        return None
    bash_script = ret.text+'echo $source_x86_64\n'
    result=subprocess.run(['bash'],text=True,input=bash_script,check=True,capture_output=True)
    url=result.stdout.split('::')[1]
    return url.strip()
if __name__ == "__main__":
    update_docker_env('TMM_URL',get_latest_url('tinymediamanager-bin'))
    time.sleep(1)
    update_docker_env('PAN_115_URL',get_latest_url('115-browser-bin'))
    time.sleep(1)
    update_docker_env('PAN_BAIDU_URL',get_latest_url('baidunetdisk-bin'))
    tag_name, urls = get_latest_release("https://github.com/outloudvi/mw2fcitx")
    for url in urls:
        if url.endswith('.dict'):
            download_url = url
            update_docker_env('MEO_DICT_URL',download_url)
            break
    tag_name, urls = get_latest_release("https://github.com/felixonmars/fcitx5-pinyin-zhwiki")

    for url in reversed(urls):
        if url.endswith('.dict'):
            download_url = url
            update_docker_env('WIKI_DICT_URL',download_url)
            break

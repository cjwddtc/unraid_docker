# coding=utf-8
import requests
from bs4 import BeautifulSoup
import re
from urllib.parse import urljoin

def get_linux_x86_64_tmm_link():
    # 目标下载页URL
    target_url = "https://release.tinymediamanager.org/download_v5.html"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }

    # 1. 请求页面并解析文本
    resp = requests.get(target_url, headers=headers, timeout=15)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")
    base_domain = "https://release.tinymediamanager.org/"
    for a in soup.find_all('a'):
        try:
            href=a.get('href')
            if 'amd64' in href and 'linux'in href and href.endswith('.xz'):
                return urljoin(base_domain, href)
        except:
            pass
    return ''
import requests

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
        download_url = assets[0]['browser_download_url'] if assets else "No assets available"

        return tag_name, download_url
    except requests.RequestException as e:
        print(f"Error fetching release data: {e}")
        return None, None


def update_docker_env(key,new_url):
    with open('docker.env', 'r') as file:
        lines = file.readlines()

    with open('docker.env', 'w') as file:
        for line in lines:
            if line.startswith(f"{key}="):
                file.write(f'{key}={new_url}\n')
                print(f'replace {key} {new_url}')
            else:
                file.write(line)


if __name__ == "__main__":
    repo_url = "https://github.com/outloudvi/mw2fcitx"
    tag_name, _ = get_latest_release(repo_url)
    if tag_name:
        download_url = f"https://github.com/outloudvi/mw2fcitx/releases/download/{tag_name}/moegirl.dict"
        update_docker_env('MEO_DICT_URL',download_url)

    update_docker_env('TMM_URL',get_linux_x86_64_tmm_link())